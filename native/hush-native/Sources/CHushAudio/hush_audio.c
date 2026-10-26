#include "hush_audio.h"

#include <stdatomic.h>
#include <stdlib.h>

struct hush_ring {
    float *data;
    size_t capacity;
    _Atomic size_t head; // next write, owned by the producer
    _Atomic size_t tail; // next read, owned by the consumer
};

hush_ring *hush_ring_create(size_t capacity) {
    hush_ring *ring = calloc(1, sizeof(hush_ring));
    if (!ring) return NULL;
    // One slot stays empty to tell full from empty.
    ring->capacity = capacity + 1;
    ring->data = calloc(ring->capacity, sizeof(float));
    if (!ring->data) {
        free(ring);
        return NULL;
    }
    atomic_init(&ring->head, 0);
    atomic_init(&ring->tail, 0);
    return ring;
}

void hush_ring_destroy(hush_ring *ring) {
    if (!ring) return;
    free(ring->data);
    free(ring);
}

size_t hush_ring_push(hush_ring *ring, const float *samples, size_t n) {
    size_t head = atomic_load_explicit(&ring->head, memory_order_relaxed);
    size_t tail = atomic_load_explicit(&ring->tail, memory_order_acquire);
    size_t free_slots = (tail + ring->capacity - head - 1) % ring->capacity;
    if (n > free_slots) n = free_slots;
    for (size_t i = 0; i < n; i++) {
        ring->data[head] = samples[i];
        head = head + 1 == ring->capacity ? 0 : head + 1;
    }
    atomic_store_explicit(&ring->head, head, memory_order_release);
    return n;
}

size_t hush_ring_pop(hush_ring *ring, float *out, size_t max) {
    size_t tail = atomic_load_explicit(&ring->tail, memory_order_relaxed);
    size_t head = atomic_load_explicit(&ring->head, memory_order_acquire);
    size_t available = (head + ring->capacity - tail) % ring->capacity;
    if (max > available) max = available;
    for (size_t i = 0; i < max; i++) {
        out[i] = ring->data[tail];
        tail = tail + 1 == ring->capacity ? 0 : tail + 1;
    }
    atomic_store_explicit(&ring->tail, tail, memory_order_release);
    return max;
}

static inline float sample_at(const void *data, size_t i, const hush_format *f) {
    if (f->is_float && f->bits == 32) return ((const float *)data)[i];
    if (!f->is_float && f->bits == 16) return ((const int16_t *)data)[i] / 32768.0f;
    if (!f->is_float && f->bits == 32) return ((const int32_t *)data)[i] / 2147483648.0f;
    return 0.0f;
}

static inline bool supported(const hush_format *f) {
    return (f->is_float && f->bits == 32) || (!f->is_float && (f->bits == 16 || f->bits == 32));
}

void hush_push_buffers(hush_ring *ring, const AudioBufferList *buffers, const hush_format *format) {
    if (!buffers || buffers->mNumberBuffers == 0 || !supported(format)) return;
    // Pushed in small blocks so the stack buffer stays fixed-size.
    float block[256];
    size_t filled = 0;
    size_t sample_bytes = format->bits / 8;

    if (format->interleaved) {
        // One buffer holding `channels` interleaved samples per frame.
        const AudioBuffer *buf = &buffers->mBuffers[0];
        if (!buf->mData) return;
        size_t ch = buf->mNumberChannels ? buf->mNumberChannels : 1;
        size_t frames = buf->mDataByteSize / (sample_bytes * ch);
        for (size_t i = 0; i < frames; i++) {
            float acc = 0.0f;
            for (size_t c = 0; c < ch; c++) acc += sample_at(buf->mData, i * ch + c, format);
            block[filled++] = acc / (float)ch;
            if (filled == 256) {
                hush_ring_push(ring, block, filled);
                filled = 0;
            }
        }
    } else {
        // Planar: one buffer per channel; average them.
        size_t n = buffers->mNumberBuffers;
        if (format->channels && n > format->channels) n = format->channels;
        const AudioBuffer *first = &buffers->mBuffers[0];
        if (!first->mData) return;
        size_t frames = first->mDataByteSize / sample_bytes;
        for (size_t i = 0; i < frames; i++) {
            float acc = 0.0f;
            for (size_t c = 0; c < n; c++) {
                const AudioBuffer *b = &buffers->mBuffers[c];
                if (!b->mData || (i + 1) * sample_bytes > b->mDataByteSize) continue;
                acc += sample_at(b->mData, i, format);
            }
            block[filled++] = acc / (float)n;
            if (filled == 256) {
                hush_ring_push(ring, block, filled);
                filled = 0;
            }
        }
    }
    if (filled) hush_ring_push(ring, block, filled);
}

struct hush_io_ctx {
    hush_ring *ring;
    hush_format format;
};

hush_io_ctx *hush_io_ctx_create(hush_ring *ring, hush_format format) {
    hush_io_ctx *ctx = calloc(1, sizeof(hush_io_ctx));
    if (!ctx) return NULL;
    ctx->ring = ring;
    ctx->format = format;
    return ctx;
}

void hush_io_ctx_destroy(hush_io_ctx *ctx) { free(ctx); }

OSStatus hush_device_io_proc(AudioObjectID device, const AudioTimeStamp *now, const AudioBufferList *input,
                             const AudioTimeStamp *input_time, AudioBufferList *output,
                             const AudioTimeStamp *output_time, void *client) {
    (void)device, (void)now, (void)input_time, (void)output, (void)output_time;
    hush_io_ctx *ctx = client;
    if (!ctx) return noErr;
    hush_push_buffers(ctx->ring, input, &ctx->format);
    return noErr;
}

struct hush_mic_ctx {
    AudioUnit unit;
    hush_ring *ring;
    hush_format format;
    uint32_t max_frames;
    float *scratch;
    AudioBufferList list;
};

hush_mic_ctx *hush_mic_ctx_create(AudioUnit unit, hush_ring *ring, uint32_t channels, uint32_t max_frames) {
    hush_mic_ctx *ctx = calloc(1, sizeof(hush_mic_ctx));
    if (!ctx) return NULL;
    if (channels == 0) channels = 1;
    ctx->scratch = calloc((size_t)max_frames * channels, sizeof(float));
    if (!ctx->scratch) {
        free(ctx);
        return NULL;
    }
    ctx->unit = unit;
    ctx->ring = ring;
    ctx->format = (hush_format){.channels = channels, .interleaved = true, .is_float = true, .bits = 32};
    ctx->max_frames = max_frames;
    return ctx;
}

void hush_mic_ctx_destroy(hush_mic_ctx *ctx) {
    if (!ctx) return;
    free(ctx->scratch);
    free(ctx);
}

OSStatus hush_mic_input_proc(void *refcon, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *time,
                             UInt32 bus, UInt32 frames, AudioBufferList *data) {
    (void)data;
    hush_mic_ctx *ctx = refcon;
    if (!ctx || frames > ctx->max_frames) return noErr;
    ctx->list.mNumberBuffers = 1;
    ctx->list.mBuffers[0].mNumberChannels = ctx->format.channels;
    ctx->list.mBuffers[0].mDataByteSize = frames * ctx->format.channels * sizeof(float);
    ctx->list.mBuffers[0].mData = ctx->scratch;
    OSStatus status = AudioUnitRender(ctx->unit, flags, time, bus, frames, &ctx->list);
    if (status != noErr) return status;
    hush_push_buffers(ctx->ring, &ctx->list, &ctx->format);
    return noErr;
}
