#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <webp/demux.h>

#define MAX_INPUT_BYTES (128u * 1024u * 1024u)

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t block[64];
  size_t block_size;
} Sha256;

static const uint32_t kSha256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
    0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
    0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
    0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
    0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
    0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
    0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
    0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

static uint32_t rotate_right(uint32_t value, unsigned amount) {
  return (value >> amount) | (value << (32u - amount));
}

static void sha256_transform(Sha256* context, const uint8_t* block) {
  uint32_t words[64];
  uint32_t a, b, c, d, e, f, g, h;
  unsigned index;
  for (index = 0; index < 16; ++index) {
    const unsigned offset = index * 4;
    words[index] = ((uint32_t)block[offset] << 24) |
                   ((uint32_t)block[offset + 1] << 16) |
                   ((uint32_t)block[offset + 2] << 8) |
                   (uint32_t)block[offset + 3];
  }
  for (index = 16; index < 64; ++index) {
    const uint32_t s0 = rotate_right(words[index - 15], 7) ^
                        rotate_right(words[index - 15], 18) ^
                        (words[index - 15] >> 3);
    const uint32_t s1 = rotate_right(words[index - 2], 17) ^
                        rotate_right(words[index - 2], 19) ^
                        (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  a = context->state[0];
  b = context->state[1];
  c = context->state[2];
  d = context->state[3];
  e = context->state[4];
  f = context->state[5];
  g = context->state[6];
  h = context->state[7];
  for (index = 0; index < 64; ++index) {
    const uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^
                          rotate_right(e, 25);
    const uint32_t choice = (e & f) ^ ((~e) & g);
    const uint32_t temporary1 =
        h + sum1 + choice + kSha256[index] + words[index];
    const uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^
                          rotate_right(a, 22);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temporary2 = sum0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary1;
    d = c;
    c = b;
    b = a;
    a = temporary1 + temporary2;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_init(Sha256* context) {
  const uint32_t initial[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u,
                               0xa54ff53au, 0x510e527fu, 0x9b05688cu,
                               0x1f83d9abu, 0x5be0cd19u};
  memcpy(context->state, initial, sizeof(initial));
  context->bit_count = 0;
  context->block_size = 0;
}

static void sha256_update(Sha256* context, const uint8_t* data, size_t size) {
  while (size > 0) {
    const size_t capacity = sizeof(context->block) - context->block_size;
    const size_t count = size < capacity ? size : capacity;
    memcpy(context->block + context->block_size, data, count);
    context->block_size += count;
    context->bit_count += (uint64_t)count * 8u;
    data += count;
    size -= count;
    if (context->block_size == sizeof(context->block)) {
      sha256_transform(context, context->block);
      context->block_size = 0;
    }
  }
}

static void sha256_finish(Sha256* context, char output[65]) {
  uint8_t digest[32];
  unsigned index;
  context->block[context->block_size++] = 0x80;
  if (context->block_size > 56) {
    memset(context->block + context->block_size, 0,
           sizeof(context->block) - context->block_size);
    sha256_transform(context, context->block);
    context->block_size = 0;
  }
  memset(context->block + context->block_size, 0, 56 - context->block_size);
  for (index = 0; index < 8; ++index)
    context->block[63 - index] =
        (uint8_t)(context->bit_count >> (unsigned)(index * 8));
  sha256_transform(context, context->block);
  for (index = 0; index < 8; ++index) {
    digest[index * 4] = (uint8_t)(context->state[index] >> 24);
    digest[index * 4 + 1] = (uint8_t)(context->state[index] >> 16);
    digest[index * 4 + 2] = (uint8_t)(context->state[index] >> 8);
    digest[index * 4 + 3] = (uint8_t)context->state[index];
  }
  for (index = 0; index < sizeof(digest); ++index)
    sprintf(output + index * 2, "%02x", digest[index]);
  output[64] = '\0';
}

static uint8_t* read_input(const char* filename, size_t* size) {
  FILE* input = fopen(filename, "rb");
  uint8_t* bytes;
  long length;
  if (input == NULL || fseek(input, 0, SEEK_END) != 0 ||
      (length = ftell(input)) <= 0 || (unsigned long)length > MAX_INPUT_BYTES ||
      fseek(input, 0, SEEK_SET) != 0) {
    if (input != NULL) fclose(input);
    return NULL;
  }
  bytes = (uint8_t*)malloc((size_t)length);
  if (bytes == NULL || fread(bytes, 1, (size_t)length, input) != (size_t)length) {
    free(bytes);
    fclose(input);
    return NULL;
  }
  fclose(input);
  *size = (size_t)length;
  return bytes;
}

int main(int argc, char** argv) {
  WebPAnimDecoderOptions options;
  WebPAnimDecoder* decoder;
  WebPAnimInfo info;
  WebPData data;
  uint8_t* bytes;
  size_t size;
  int prior_timestamp = 0;
  uint32_t frame_index = 0;
  if (argc != 2) {
    fputs("animation oracle requires one input\n", stderr);
    return 2;
  }
  bytes = read_input(argv[1], &size);
  if (bytes == NULL) {
    fputs("animation oracle could not read bounded input\n", stderr);
    return 2;
  }
  data.bytes = bytes;
  data.size = size;
  if (!WebPAnimDecoderOptionsInit(&options)) {
    free(bytes);
    fputs("animation oracle ABI mismatch\n", stderr);
    return 2;
  }
  options.color_mode = MODE_RGBA;
  options.use_threads = 0;
  decoder = WebPAnimDecoderNew(&data, &options);
  if (decoder == NULL || !WebPAnimDecoderGetInfo(decoder, &info)) {
    if (decoder != NULL) WebPAnimDecoderDelete(decoder);
    free(bytes);
    fputs("animation oracle rejected input\n", stderr);
    return 1;
  }
  printf("{\"status\":\"success\",\"canvasWidth\":%u,\"canvasHeight\":%u,"
         "\"frameCount\":%u,\"loopCount\":%u,\"backgroundColor\":%u,"
         "\"frames\":[",
         info.canvas_width, info.canvas_height, info.frame_count,
         info.loop_count, info.bgcolor);
  while (WebPAnimDecoderHasMoreFrames(decoder)) {
    uint8_t* canvas = NULL;
    int timestamp = 0;
    Sha256 hash;
    char hexadecimal[65];
    if (!WebPAnimDecoderGetNext(decoder, &canvas, &timestamp) ||
        canvas == NULL) {
      WebPAnimDecoderDelete(decoder);
      free(bytes);
      fputs("animation oracle frame decode failed\n", stderr);
      return 1;
    }
    sha256_init(&hash);
    sha256_update(&hash, canvas,
                  (size_t)info.canvas_width * info.canvas_height * 4u);
    sha256_finish(&hash, hexadecimal);
    printf("%s{\"index\":%u,\"timestampMs\":%d,\"durationMs\":%d,"
           "\"rgbaSha256\":\"%s\"}",
           frame_index == 0 ? "" : ",", frame_index, timestamp,
           timestamp - prior_timestamp, hexadecimal);
    prior_timestamp = timestamp;
    ++frame_index;
  }
  puts("]}");
  WebPAnimDecoderDelete(decoder);
  free(bytes);
  return frame_index == info.frame_count ? 0 : 1;
}
