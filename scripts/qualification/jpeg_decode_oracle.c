/*
 * Raw-component libjpeg-turbo decode oracle (Plan 57-08).
 *
 * Reads a JPEG file, decodes it with `out_color_space` set to the file's own
 * `jpeg_color_space` (raw components -- no colour transform; grayscale,
 * YCbCr, RGB, CMYK and YCCK all decode as their native component layout),
 * and prints:
 *
 *   1. one text line "DIM <width> <height> <output_components>
 *      <jpeg_color_space>\n" to stdout
 *   2. the decoded scanline bytes (row-major, output_width *
 *      output_components bytes per row) written immediately after, with no
 *      separator
 *
 * `tests/qualification/jpeg/oracles.ts`'s `jpegDecodePixels` splits the
 * first line from the pixel bytes and sha256-hashes them -- this program
 * never hashes anything itself, mirroring `png_decode_oracle.c`'s own
 * decode/hash separation (T-56-50-style independence).
 *
 * Exits non-zero (2 on usage error, 1 on any libjpeg error via the setjmp
 * error manager) on any malformed input; never partially decodes.
 */
#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>
#include <jerror.h>
#include <setjmp.h>

/* LIBJPEG_TURBO_VERSION (jconfig.h) is an unquoted numeric-looking token
 * (e.g. `3.2.0`), not a string literal -- stringify it before concatenating
 * with a string literal below. */
#define ORACLE_STR2(x) #x
#define ORACLE_STR(x) ORACLE_STR2(x)

struct oracle_error_mgr {
  struct jpeg_error_mgr pub;
  jmp_buf setjmp_buffer;
};

static void oracle_error_exit(j_common_ptr cinfo) {
  struct oracle_error_mgr *err = (struct oracle_error_mgr *)cinfo->err;
  char buffer[JMSG_LENGTH_MAX];
  (*cinfo->err->format_message)(cinfo, buffer);
  fprintf(stderr, "jpeg_decode_oracle: %s\n", buffer);
  longjmp(err->setjmp_buffer, 1);
}

int main(int argc, char **argv) {
  FILE *input;
  struct jpeg_decompress_struct cinfo;
  struct oracle_error_mgr jerr;
  JSAMPROW row_pointer[1];
  int row_stride;

  /*
   * Printed unconditionally (even on a usage error) so the builder can
   * confirm which libjpeg-turbo the oracle was actually linked against,
   * mirroring png_decode_oracle.c's own unconditional stderr identification.
   */
  fprintf(stderr, "jpeg_decode_oracle: libjpeg-turbo %s\n",
          ORACLE_STR(LIBJPEG_TURBO_VERSION));

  if (argc != 2) {
    fputs("jpeg decode oracle requires one input\n", stderr);
    return 2;
  }

  input = fopen(argv[1], "rb");
  if (input == NULL) {
    fputs("jpeg decode oracle could not open input\n", stderr);
    return 2;
  }

  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = oracle_error_exit;
  if (setjmp(jerr.setjmp_buffer)) {
    jpeg_destroy_decompress(&cinfo);
    fclose(input);
    return 1;
  }

  jpeg_create_decompress(&cinfo);
  jpeg_stdio_src(&cinfo, input);
  (void)jpeg_read_header(&cinfo, TRUE);

  cinfo.out_color_space = cinfo.jpeg_color_space;

  (void)jpeg_start_decompress(&cinfo);
  row_stride = cinfo.output_width * cinfo.output_components;

  if (printf("DIM %u %u %d %d\n", cinfo.output_width, cinfo.output_height,
             cinfo.output_components, (int)cinfo.jpeg_color_space) < 0) {
    jpeg_destroy_decompress(&cinfo);
    fclose(input);
    fputs("jpeg decode oracle could not write header\n", stderr);
    return 1;
  }

  row_pointer[0] = (JSAMPROW)malloc(row_stride);
  if (row_pointer[0] == NULL) {
    jpeg_destroy_decompress(&cinfo);
    fclose(input);
    fputs("jpeg decode oracle could not allocate a row buffer\n", stderr);
    return 1;
  }

  while (cinfo.output_scanline < cinfo.output_height) {
    (void)jpeg_read_scanlines(&cinfo, row_pointer, 1);
    if (fwrite(row_pointer[0], 1, (size_t)row_stride, stdout) !=
        (size_t)row_stride) {
      free(row_pointer[0]);
      jpeg_destroy_decompress(&cinfo);
      fclose(input);
      fputs("jpeg decode oracle could not write scanline\n", stderr);
      return 1;
    }
  }
  fflush(stdout);
  free(row_pointer[0]);

  (void)jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  fclose(input);
  return 0;
}
