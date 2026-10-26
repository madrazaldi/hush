// Realtime-safe pieces of audio capture: a single-producer single-consumer ring of mono f32
// samples, and the Core Audio callbacks that downmix whatever the device delivers into it.
// Nothing here allocates or locks once capture is running.

#ifndef HUSH_AUDIO_H
#define HUSH_AUDIO_H

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#pragma clang assume_nonnull begin

typedef struct hush_ring hush_ring;

hush_ring *_Nullable hush_ring_create(size_t capacity);
void hush_ring_destroy(hush_ring *_Nullable ring);
/// Append up to `n` samples; what does not fit is dropped. Returns the number written.
size_t hush_ring_push(hush_ring *ring, const float *samples, size_t n);
/// Take up to `max` samples. Returns the number read.
size_t hush_ring_pop(hush_ring *ring, float *out, size_t max);

/// How the device lays out its samples.
typedef struct {
    uint32_t channels;
    bool interleaved;
    bool is_float;
    uint32_t bits;
} hush_format;

/// Downmix a buffer list in `format` to mono and push it into `ring`.
void hush_push_buffers(hush_ring *ring, const AudioBufferList *_Nullable buffers, const hush_format *format);

/// Client data for `hush_device_io_proc` (the system-audio aggregate device).
typedef struct hush_io_ctx hush_io_ctx;

hush_io_ctx *_Nullable hush_io_ctx_create(hush_ring *ring, hush_format format);
void hush_io_ctx_destroy(hush_io_ctx *_Nullable ctx);

// Matches AudioDeviceIOProc, nullability included, so Swift can pass it directly.
OSStatus hush_device_io_proc(AudioObjectID device, const AudioTimeStamp *now,
                             const AudioBufferList *input, const AudioTimeStamp *input_time,
                             AudioBufferList *output, const AudioTimeStamp *output_time,
                             void *_Nullable client);

/// Input callback state for an AUHAL microphone unit rendering f32 interleaved frames.
typedef struct hush_mic_ctx hush_mic_ctx;

hush_mic_ctx *_Nullable hush_mic_ctx_create(AudioUnit unit, hush_ring *ring, uint32_t channels, uint32_t max_frames);
void hush_mic_ctx_destroy(hush_mic_ctx *_Nullable ctx);

// Matches AURenderCallback.
OSStatus hush_mic_input_proc(void *refcon, AudioUnitRenderActionFlags *flags,
                             const AudioTimeStamp *time, UInt32 bus, UInt32 frames,
                             AudioBufferList *_Nullable data);

#pragma clang assume_nonnull end

#endif
