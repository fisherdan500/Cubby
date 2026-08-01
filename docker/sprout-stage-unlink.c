#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int is_staged_filename(const char *name) {
  static const char prefix[] = "sprout-stage-";
  static const char suffix[] = ".bin";
  const size_t prefix_length = sizeof(prefix) - 1;
  const size_t suffix_length = sizeof(suffix) - 1;
  const size_t filename_length = strlen(name);

  if (filename_length != prefix_length + 32 + suffix_length) return 0;
  if (memcmp(name, prefix, prefix_length) != 0) return 0;
  if (memcmp(name + filename_length - suffix_length, suffix, suffix_length) != 0) return 0;

  for (size_t index = prefix_length; index < prefix_length + 32; index += 1) {
    if (!((name[index] >= 'a' && name[index] <= 'f') || (name[index] >= '0' && name[index] <= '9'))) return 0;
  }

  return 1;
}

int main(int argc, char *argv[]) {
  struct stat directory_stats;
  struct stat staged_file_stats;
  int directory_fd;

  if (argc != 3 || argv[1][0] != '/' || strcmp(argv[1], "/") == 0 || !is_staged_filename(argv[2])) return 64;

  directory_fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) return 1;

  if (fstat(directory_fd, &directory_stats) != 0 || !S_ISDIR(directory_stats.st_mode)) {
    close(directory_fd);
    return 1;
  }

  if (fstatat(directory_fd, argv[2], &staged_file_stats, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      close(directory_fd);
      return 0;
    }
    close(directory_fd);
    return 1;
  }

  if (!S_ISREG(staged_file_stats.st_mode)) {
    close(directory_fd);
    return 1;
  }

  if (unlinkat(directory_fd, argv[2], 0) != 0) {
    close(directory_fd);
    return 1;
  }

  return close(directory_fd) == 0 ? 0 : 1;
}
