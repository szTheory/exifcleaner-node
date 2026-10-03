/*
 * Whole-graph libheif decode oracle (Plan 62.1-03, D-23, QUA-04).
 *
 * `heif_decode_oracle <input> <planes-dir>`
 *
 * Reads a HEIC/AVIF file and decodes EVERY image reachable in its graph: each top-level image
 * (the primary one included), each of its thumbnails, and each of its auxiliary images (filter 0
 * -- alpha, depth and the hdrgainmap URN all included, nothing omitted). Every decode uses
 * `heif_colorspace_undefined`/`heif_chroma_undefined` (the image's own native colorspace/chroma,
 * no conversion) and `ignore_transformations = 0` (grid, irot, imir and clap are applied), so the
 * decode reflects exactly what libheif considers the image's displayed pixels to be.
 *
 * For each image, in walk order, this program:
 *
 *   1. Writes one text line to stdout:
 *        "IMG <role> <itemId> <width> <height> <chroma> <bitDepth> <alpha> <nclx> <icc>\n"
 *      where <role> is "primary", "toplevel", "thumbnail" or "auxiliary"; <alpha> is 0/1;
 *      <nclx>/<icc> are the literal tokens "nclx"/"none" and "icc"/"none".
 *   2. Writes that image's raw decoded planes (stride-stripped, in a fixed channel order) to
 *      "<planes-dir>/<index>.planes", where <index> is the 0-based position of this image's own
 *      header line among all header lines this run emits.
 *
 * Planes go to files, never to stdout: a 12MP whole-graph decode can be tens of megabytes per
 * image, and stdout stays a small, cheaply-parsed text stream.
 *
 * Prints "heif_decode_oracle: libheif <version>\n" to stderr unconditionally (even on a usage
 * error), mirroring every other decode oracle in this directory. Exits non-zero with a reason
 * printed to stderr on any failure (bad usage: 2; a read/handle/decode failure: 1); never
 * partially decodes a graph it cannot fully walk.
 */
#include <stdio.h>
#include <stdlib.h>
#include <libheif/heif.h>

static const enum heif_channel CHANNEL_ORDER[] = {
    heif_channel_Y,           heif_channel_Cb,     heif_channel_Cr,
    heif_channel_R,           heif_channel_G,      heif_channel_B,
    heif_channel_Alpha,       heif_channel_interleaved,
};
#define CHANNEL_ORDER_COUNT \
  (int)(sizeof(CHANNEL_ORDER) / sizeof(CHANNEL_ORDER[0]))

/* Writes one channel's plane, row by row, stride stripped. `heif_image_get_bits_per_pixel`
 * reports the whole stored-pixel width (for an interleaved channel, every component together),
 * so `width * bitsPerPixel` bits is always the real row content width regardless of planar vs.
 * interleaved layout. Returns -1 on any unexpected shape or short write. */
static int write_plane(FILE *out, const struct heif_image *img,
                        enum heif_channel channel) {
  int width = heif_image_get_width(img, channel);
  int height = heif_image_get_height(img, channel);
  int stride = 0;
  const uint8_t *data = heif_image_get_plane_readonly(img, channel, &stride);
  if (data == NULL || width <= 0 || height <= 0 || stride <= 0) return -1;

  int bitsPerPixel = heif_image_get_bits_per_pixel(img, channel);
  if (bitsPerPixel <= 0) return -1;
  size_t rowBytes = ((size_t)width * (size_t)bitsPerPixel + 7) / 8;
  if (rowBytes > (size_t)stride) return -1;

  for (int row = 0; row < height; row++) {
    if (fwrite(data + (size_t)row * (size_t)stride, 1, rowBytes, out) !=
        rowBytes) {
      return -1;
    }
  }
  return 0;
}

static int write_planes_file(const char *planesDir, int index,
                              const struct heif_image *img) {
  char path[4096];
  int written = snprintf(path, sizeof(path), "%s/%d.planes", planesDir, index);
  if (written <= 0 || (size_t)written >= sizeof(path)) return -1;

  FILE *out = fopen(path, "wb");
  if (out == NULL) return -1;

  int result = 0;
  for (int i = 0; i < CHANNEL_ORDER_COUNT; i++) {
    enum heif_channel channel = CHANNEL_ORDER[i];
    if (!heif_image_has_channel(img, channel)) continue;
    if (write_plane(out, img, channel) != 0) {
      result = -1;
      break;
    }
  }
  fclose(out);
  return result;
}

/* Decodes one handle (a top-level image, a thumbnail, or an auxiliary image) and emits its header
 * line plus its planes file at `*nextIndex`, incrementing `*nextIndex` on success. Returns 0 on
 * success, non-zero on any failure (already reported to stderr by this function). */
static int decode_and_emit(const char *planesDir, int *nextIndex,
                            struct heif_image_handle *handle,
                            const char *role) {
  struct heif_decoding_options *options = heif_decoding_options_alloc();
  if (options == NULL) {
    fputs("heif_decode_oracle: could not allocate decoding options\n", stderr);
    return 1;
  }
  options->ignore_transformations = 0;

  struct heif_image *img = NULL;
  struct heif_error error = heif_decode_image(
      handle, &img, heif_colorspace_undefined, heif_chroma_undefined, options);
  heif_decoding_options_free(options);
  if (error.code != heif_error_Ok || img == NULL) {
    fprintf(stderr, "heif_decode_oracle: decode failed for %s: %s\n", role,
            error.message != NULL ? error.message : "unknown error");
    return 1;
  }

  heif_item_id itemId = heif_image_handle_get_item_id(handle);
  int width = heif_image_handle_get_width(handle);
  int height = heif_image_handle_get_height(handle);
  int alpha = heif_image_handle_has_alpha_channel(handle) ? 1 : 0;
  int chroma = (int)heif_image_get_chroma_format(img);

  enum heif_channel mainChannel;
  if (heif_image_has_channel(img, heif_channel_interleaved)) {
    mainChannel = heif_channel_interleaved;
  } else if (heif_image_has_channel(img, heif_channel_Y)) {
    mainChannel = heif_channel_Y;
  } else {
    mainChannel = heif_channel_R;
  }
  int bitDepth = heif_image_get_bits_per_pixel_range(img, mainChannel);

  struct heif_color_profile_nclx *nclx = NULL;
  struct heif_error nclxError =
      heif_image_handle_get_nclx_color_profile(handle, &nclx);
  int hasNclx = (nclxError.code == heif_error_Ok && nclx != NULL) ? 1 : 0;
  if (nclx != NULL) heif_nclx_color_profile_free(nclx);

  enum heif_color_profile_type profileType =
      heif_image_handle_get_color_profile_type(handle);
  int hasIcc = (profileType == heif_color_profile_type_prof ||
                profileType == heif_color_profile_type_rICC)
                   ? 1
                   : 0;

  int index = *nextIndex;
  if (write_planes_file(planesDir, index, img) != 0) {
    fprintf(stderr,
            "heif_decode_oracle: could not write planes for %s item %llu\n",
            role, (unsigned long long)itemId);
    heif_image_release(img);
    return 1;
  }
  heif_image_release(img);

  if (printf("IMG %s %llu %d %d %d %d %d %s %s\n", role,
             (unsigned long long)itemId, width, height, chroma, bitDepth,
             alpha, hasNclx ? "nclx" : "none", hasIcc ? "icc" : "none") < 0) {
    fputs("heif_decode_oracle: could not write header line\n", stderr);
    return 1;
  }
  *nextIndex += 1;
  return 0;
}

/* Decodes every thumbnail of `handle`, in `heif_image_handle_get_list_of_thumbnail_IDs` order.
 * Returns 0 on success, non-zero on the first failure. */
static int decode_thumbnails(const char *planesDir, int *nextIndex,
                              struct heif_image_handle *handle) {
  int thumbCount = heif_image_handle_get_number_of_thumbnails(handle);
  if (thumbCount <= 0) return 0;

  heif_item_id *thumbIds =
      (heif_item_id *)malloc(sizeof(heif_item_id) * (size_t)thumbCount);
  if (thumbIds == NULL) {
    fputs("heif_decode_oracle: out of memory\n", stderr);
    return 1;
  }
  heif_image_handle_get_list_of_thumbnail_IDs(handle, thumbIds, thumbCount);

  int result = 0;
  for (int i = 0; i < thumbCount; i++) {
    struct heif_image_handle *thumbHandle = NULL;
    struct heif_error error =
        heif_image_handle_get_thumbnail(handle, thumbIds[i], &thumbHandle);
    if (error.code != heif_error_Ok || thumbHandle == NULL) {
      fprintf(stderr,
              "heif_decode_oracle: could not get thumbnail handle: %s\n",
              error.message != NULL ? error.message : "unknown error");
      result = 1;
      break;
    }
    result = decode_and_emit(planesDir, nextIndex, thumbHandle, "thumbnail");
    heif_image_handle_release(thumbHandle);
    if (result != 0) break;
  }
  free(thumbIds);
  return result;
}

/* Decodes every auxiliary image of `handle` with filter 0 (no omission -- alpha, depth and the
 * hdrgainmap URN are all included). Returns 0 on success, non-zero on the first failure. */
static int decode_auxiliary_images(const char *planesDir, int *nextIndex,
                                    struct heif_image_handle *handle) {
  int auxCount = heif_image_handle_get_number_of_auxiliary_images(handle, 0);
  if (auxCount <= 0) return 0;

  heif_item_id *auxIds =
      (heif_item_id *)malloc(sizeof(heif_item_id) * (size_t)auxCount);
  if (auxIds == NULL) {
    fputs("heif_decode_oracle: out of memory\n", stderr);
    return 1;
  }
  heif_image_handle_get_list_of_auxiliary_image_IDs(handle, 0, auxIds,
                                                      auxCount);

  int result = 0;
  for (int i = 0; i < auxCount; i++) {
    struct heif_image_handle *auxHandle = NULL;
    struct heif_error error =
        heif_image_handle_get_auxiliary_image(handle, auxIds[i], &auxHandle);
    if (error.code != heif_error_Ok || auxHandle == NULL) {
      fprintf(stderr,
              "heif_decode_oracle: could not get auxiliary handle: %s\n",
              error.message != NULL ? error.message : "unknown error");
      result = 1;
      break;
    }
    result = decode_and_emit(planesDir, nextIndex, auxHandle, "auxiliary");
    heif_image_handle_release(auxHandle);
    if (result != 0) break;
  }
  free(auxIds);
  return result;
}

int main(int argc, char **argv) {
  /* Printed unconditionally (even on a usage error), mirroring every other decode oracle in this
   * directory, so the builder can confirm which libheif the oracle was actually linked against. */
  fprintf(stderr, "heif_decode_oracle: libheif %s\n", heif_get_version());

  if (argc != 3) {
    fputs("heif decode oracle requires <input> <planes-dir>\n", stderr);
    return 2;
  }
  const char *inputPath = argv[1];
  const char *planesDir = argv[2];

  struct heif_context *ctx = heif_context_alloc();
  if (ctx == NULL) {
    fputs("heif decode oracle could not allocate context\n", stderr);
    return 2;
  }

  struct heif_error error = heif_context_read_from_file(ctx, inputPath, NULL);
  if (error.code != heif_error_Ok) {
    fprintf(stderr, "heif_decode_oracle: could not read input: %s\n",
            error.message != NULL ? error.message : "unknown error");
    heif_context_free(ctx);
    return 1;
  }

  int topCount = heif_context_get_number_of_top_level_images(ctx);
  if (topCount <= 0) {
    fputs("heif_decode_oracle: no top-level images found\n", stderr);
    heif_context_free(ctx);
    return 1;
  }

  heif_item_id *topIds =
      (heif_item_id *)malloc(sizeof(heif_item_id) * (size_t)topCount);
  if (topIds == NULL) {
    fputs("heif_decode_oracle: out of memory\n", stderr);
    heif_context_free(ctx);
    return 1;
  }
  heif_context_get_list_of_top_level_image_IDs(ctx, topIds, topCount);

  int nextIndex = 0;
  int status = 0;

  for (int i = 0; i < topCount; i++) {
    struct heif_image_handle *handle = NULL;
    error = heif_context_get_image_handle(ctx, topIds[i], &handle);
    if (error.code != heif_error_Ok || handle == NULL) {
      fprintf(stderr, "heif_decode_oracle: could not get image handle: %s\n",
              error.message != NULL ? error.message : "unknown error");
      status = 1;
      break;
    }

    const char *role =
        heif_image_handle_is_primary_image(handle) ? "primary" : "toplevel";
    status = decode_and_emit(planesDir, &nextIndex, handle, role);
    if (status == 0) status = decode_thumbnails(planesDir, &nextIndex, handle);
    if (status == 0)
      status = decode_auxiliary_images(planesDir, &nextIndex, handle);

    heif_image_handle_release(handle);
    if (status != 0) break;
  }

  free(topIds);
  heif_context_free(ctx);
  return status == 0 ? 0 : 1;
}
