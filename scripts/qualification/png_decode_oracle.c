/*
 * libpng identity-decode oracle (Plan 56-08).
 *
 * Reads a PNG file, decodes it with PNG_TRANSFORM_IDENTITY (no gamma, no
 * colour transform, no strip/expand), and prints:
 *
 *   1. one text line "IHDR <width> <height> <bit_depth> <color_type>
 *      <interlace>\n" to stdout
 *   2. the decoded row bytes (row-major, exactly png_get_rowbytes() per
 *      row) written immediately after, with no separator
 *
 * `tests/qualification/png/oracles.ts`'s `runPngDecodeOracle` splits the
 * first line from the row bytes and sha256-hashes the rows -- this program
 * never hashes anything itself, so the oracle and the hash it trusts are
 * computed by two independent pieces of code.
 *
 * Exits non-zero (via libpng's own error longjmp, or a local bounds check)
 * on any malformed input; never partially decodes.
 */
#include <png.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv) {
  FILE* input;
  png_structp png_ptr;
  png_infop info_ptr;
  png_uint_32 width, height, row_index;
  int bit_depth, color_type, interlace_type;
  png_bytepp rows;
  size_t row_bytes;

  /*
   * Printed unconditionally (even on a usage error) so the builder can
   * confirm which libpng the oracle was actually linked against without a
   * separate `-version` flag -- the oracle's only argument is the input
   * path, per its I/O contract above.
   */
  fprintf(stderr, "png_decode_oracle: libpng %s\n", png_get_libpng_ver(NULL));

  if (argc != 2) {
    fputs("png decode oracle requires one input\n", stderr);
    return 2;
  }

  input = fopen(argv[1], "rb");
  if (input == NULL) {
    fputs("png decode oracle could not open input\n", stderr);
    return 2;
  }

  png_ptr =
      png_create_read_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
  if (png_ptr == NULL) {
    fclose(input);
    fputs("png decode oracle could not allocate\n", stderr);
    return 2;
  }
  info_ptr = png_create_info_struct(png_ptr);
  if (info_ptr == NULL) {
    png_destroy_read_struct(&png_ptr, NULL, NULL);
    fclose(input);
    fputs("png decode oracle could not allocate\n", stderr);
    return 2;
  }

  if (setjmp(png_jmpbuf(png_ptr))) {
    png_destroy_read_struct(&png_ptr, &info_ptr, NULL);
    fclose(input);
    fputs("png decode oracle rejected input\n", stderr);
    return 1;
  }

  png_init_io(png_ptr, input);
  png_read_png(png_ptr, info_ptr, PNG_TRANSFORM_IDENTITY, NULL);

  png_get_IHDR(png_ptr, info_ptr, &width, &height, &bit_depth, &color_type,
               &interlace_type, NULL, NULL);
  if (printf("IHDR %lu %lu %d %d %d\n", (unsigned long)width,
             (unsigned long)height, bit_depth, color_type,
             interlace_type) < 0) {
    png_destroy_read_struct(&png_ptr, &info_ptr, NULL);
    fclose(input);
    fputs("png decode oracle could not write header\n", stderr);
    return 1;
  }

  rows = png_get_rows(png_ptr, info_ptr);
  row_bytes = png_get_rowbytes(png_ptr, info_ptr);
  if (rows == NULL || row_bytes == 0) {
    png_destroy_read_struct(&png_ptr, &info_ptr, NULL);
    fclose(input);
    fputs("png decode oracle produced no rows\n", stderr);
    return 1;
  }
  for (row_index = 0; row_index < height; ++row_index) {
    if (fwrite(rows[row_index], 1, row_bytes, stdout) != row_bytes) {
      png_destroy_read_struct(&png_ptr, &info_ptr, NULL);
      fclose(input);
      fputs("png decode oracle could not write rows\n", stderr);
      return 1;
    }
  }
  fflush(stdout);

  png_destroy_read_struct(&png_ptr, &info_ptr, NULL);
  fclose(input);
  return 0;
}
