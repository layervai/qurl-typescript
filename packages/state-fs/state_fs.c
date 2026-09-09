#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>

/* Only descriptor-relative filesystem operations live here. Lifecycle and sealing stay in TS. */
typedef struct {
  int dir, lock;
  char path[PATH_MAX], name[256], lockname[272];
  struct stat directory, locked;
} store;

static napi_value fail(napi_env env, const char *code) {
  napi_throw_error(env, code, "qURL state filesystem operation failed");
  return NULL;
}
static napi_value undef(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
static int same(struct stat *a, struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static void wipe(void *data, size_t length) {
  volatile unsigned char *bytes = data;
  while (length--) *bytes++ = 0;
}
static int unchanged(struct stat *a, struct stat *b) {
#ifdef __APPLE__
  return same(a,b) && a->st_size == b->st_size && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
  return same(a,b) && a->st_size == b->st_size && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}
static int private_file(struct stat *s) {
  return S_ISREG(s->st_mode) && s->st_uid == geteuid() && (s->st_mode & 07777) == 0600 && s->st_nlink == 1;
}
static int walk(const char *path, int create) {
  if (path[0] != '/') { errno = EINVAL; return -1; }
  char copy[PATH_MAX];
  if (strlen(path) >= sizeof(copy)) { errno = ENAMETOOLONG; return -1; }
  strcpy(copy, path);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  while (fd >= 0 && part) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); errno = EINVAL; return -1; }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 && errno == ENOENT && create) {
      int made = mkdirat(fd, part, 0700) == 0;
      if (made || errno == EEXIST) {
        next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        // A durable state file also needs each newly created parent entry persisted.
        if (made && fsync(fd)) { if (next >= 0) close(next); close(fd); return -1; }
      }
    }
    close(fd); fd = next;
    if (fd < 0) break;
    struct stat s;
    if (fstat(fd, &s) || (s.st_uid != 0 && s.st_uid != geteuid()) ||
        ((s.st_mode & 0022) && !(s.st_uid == 0 && (s.st_mode & S_ISVTX)))) {
      close(fd); errno = EPERM; return -1;
    }
    part = strtok_r(NULL, "/", &save);
  }
  return fd;
}
static int continuity(store *s) {
  if (s->dir < 0) return 0;
  int current = walk(s->path, 0);
  if (current < 0) return 0;
  struct stat a, b;
  int ok = !fstat(current, &a) && !fstat(s->dir, &b) && same(&a, &s->directory) && same(&a, &b)
    && a.st_uid == geteuid() && (a.st_mode & 07777) == 0700;
  close(current);
  if (ok && s->lock >= 0) {
    ok = !fstatat(s->dir, s->lockname, &a, AT_SYMLINK_NOFOLLOW) && private_file(&a)
      && same(&a, &s->locked) && !fstat(s->lock, &b) && same(&a, &b);
  }
  return ok;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; store *s = data;
  if (s->lock >= 0) close(s->lock);
  if (s->dir >= 0) close(s->dir);
  free(s);
}
static store *handle(napi_env env, napi_value v) {
  store *s = NULL;
  if (napi_get_value_external(env, v, (void **)&s) != napi_ok || !s || !continuity(s)) {
    fail(env, "STATE_CONTINUITY"); return NULL;
  }
  return s;
}
static int string(napi_env env, napi_value v, char *out, size_t capacity) {
  size_t n, copied;
  return napi_get_value_string_utf8(env, v, NULL, 0, &n) == napi_ok && n < capacity &&
    napi_get_value_string_utf8(env, v, out, capacity, &copied) == napi_ok && copied == n && strlen(out) == n;
}
static napi_value open_store(napi_env env, napi_callback_info info) {
  size_t n = 2; napi_value args[2]; napi_get_cb_info(env, info, &n, args, NULL, NULL);
  store *s = calloc(1, sizeof(store));
  if (!s) return fail(env, "STATE_MEMORY");
  s->dir = s->lock = -1;
  if (n != 2 || !string(env, args[0], s->path, sizeof(s->path)) || !string(env, args[1], s->name, sizeof(s->name)) ||
      !s->name[0] || strchr(s->name, '/') || !strcmp(s->name, ".") || !strcmp(s->name, "..")) {
    free(s); return fail(env, "STATE_PATH");
  }
  snprintf(s->lockname, sizeof(s->lockname), "%s.lock", s->name);
  s->dir = walk(s->path, 1);
  if (s->dir < 0 || fstat(s->dir, &s->directory) || !continuity(s)) {
    finalize(env, s, NULL); return fail(env, "STATE_CONTINUITY");
  }
  napi_value value;
  if (napi_create_external(env, s, finalize, NULL, &value) != napi_ok) { finalize(env, s, NULL); return fail(env, "STATE_MEMORY"); }
  return value;
}
static napi_value check(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(env, info, &n, &arg, NULL, NULL);
  return n == 1 && handle(env, arg) ? undef(env) : fail(env, "STATE_CONTINUITY");
}
static napi_value lock_store(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value arg, value; napi_get_cb_info(env, info, &n, &arg, NULL, NULL);
  store *s = n == 1 ? handle(env, arg) : NULL;
  if (!s) return NULL;
  if (s->lock >= 0) return fail(env, "STATE_LOCKED");
  int fd = openat(s->dir, s->lockname, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  struct stat st;
  if (fd < 0) return fail(env, "STATE_LOCK");
  if (fstat(fd, &st) || !private_file(&st)) { close(fd); return fail(env, "STATE_LOCK"); }
  if (flock(fd, LOCK_EX | LOCK_NB)) {
    int busy = errno == EWOULDBLOCK || errno == EAGAIN; close(fd);
    if (!busy) return fail(env, "STATE_LOCK");
    napi_get_boolean(env, false, &value); return value;
  }
  s->lock = fd; s->locked = st;
  if (!continuity(s)) { close(fd); s->lock = -1; return fail(env, "STATE_CONTINUITY"); }
  napi_get_boolean(env, true, &value); return value;
}
static napi_value unlock_store(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(env, info, &n, &arg, NULL, NULL);
  store *s = NULL;
  if (n != 1 || napi_get_value_external(env, arg, (void **)&s) != napi_ok || !s) return fail(env, "STATE_HANDLE");
  int ok = continuity(s);
  if (s->lock >= 0) { if (close(s->lock)) ok = 0; s->lock = -1; }
  return ok ? undef(env) : fail(env, "STATE_CONTINUITY");
}
static napi_value read_store(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value arg, value; napi_get_cb_info(env, info, &n, &arg, NULL, NULL);
  store *s = n == 1 ? handle(env, arg) : NULL; if (!s) return NULL;
  int fd = openat(s->dir, s->name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) { if (errno == ENOENT) { napi_get_null(env, &value); return value; } return fail(env, "STATE_READ"); }
  struct stat st, after;
  if (fstat(fd, &st) || !private_file(&st) || st.st_size < 0 || st.st_size > (2 << 20)) { close(fd); return fail(env, "STATE_FILE"); }
  size_t size = (size_t)st.st_size, offset = 0;
  unsigned char *bytes = malloc(size + 1);
  if (!bytes) { close(fd); return fail(env, "STATE_MEMORY"); }
  int ok = 1;
  while (offset < size + 1) {
    ssize_t count = read(fd, bytes + offset, size + 1 - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { ok = 0; break; }
    if (!count) break;
    offset += (size_t)count;
  }
  ok = ok && offset == size && !fstatat(s->dir, s->name, &after, AT_SYMLINK_NOFOLLOW)
    && unchanged(&st, &after) && private_file(&after) && continuity(s);
  if (close(fd)) ok = 0;
  if (ok && napi_create_buffer_copy(env, size, bytes, NULL, &value) != napi_ok) ok = 0;
  wipe(bytes, size + 1); free(bytes);
  return ok ? value : fail(env, "STATE_CONTINUITY");
}
static napi_value write_store(napi_env env, napi_callback_info info) {
  size_t n = 3, length; napi_value args[3]; void *bytes; char temp[256];
  napi_get_cb_info(env, info, &n, args, NULL, NULL);
  store *s = n == 3 ? handle(env, args[0]) : NULL; if (!s) return NULL;
  if (s->lock < 0 || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok || length > (2 << 20) ||
      !string(env, args[2], temp, sizeof(temp)) || strncmp(temp, ".qurl-", 6) || strchr(temp, '/') || !strcmp(temp, s->name)) return fail(env, "STATE_WRITE");
  struct stat old, current;
  int exists = fstatat(s->dir, s->name, &old, AT_SYMLINK_NOFOLLOW) == 0;
  if ((exists && !private_file(&old)) || (!exists && errno != ENOENT)) return fail(env, "STATE_FILE");
  int fd = openat(s->dir, temp, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return fail(env, "STATE_WRITE");
  struct stat temporary;
  if (fstat(fd, &temporary) || !private_file(&temporary)) { close(fd); unlinkat(s->dir, temp, 0); return fail(env, "STATE_FILE"); }
  size_t offset = 0; int ok = 1;
  while (offset < length) {
    ssize_t count = write(fd, (char *)bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { ok = 0; break; }
    offset += (size_t)count;
  }
  if (ok && fsync(fd)) ok = 0;
  if (close(fd)) ok = 0;
  int present = fstatat(s->dir, s->name, &current, AT_SYMLINK_NOFOLLOW) == 0;
  if (present != exists || (present && (!unchanged(&old, &current) || !private_file(&current))) || (!present && errno != ENOENT)) ok = 0;
  if (!continuity(s)) ok = 0;
  struct stat named;
  if (fstatat(s->dir, temp, &named, AT_SYMLINK_NOFOLLOW) || !same(&temporary, &named) || !private_file(&named)) ok = 0;
  if (ok && renameat(s->dir, temp, s->dir, s->name)) ok = 0;
  if (ok && fsync(s->dir)) ok = 0;
  if (!ok) { unlinkat(s->dir, temp, 0); return fail(env, "STATE_WRITE"); }
  return continuity(s) ? undef(env) : fail(env, "STATE_CONTINUITY");
}
static napi_value close_store(napi_env env, napi_callback_info info) {
  size_t n = 1; napi_value arg; napi_get_cb_info(env, info, &n, &arg, NULL, NULL); store *s = NULL;
  if (n != 1 || napi_get_value_external(env, arg, (void **)&s) != napi_ok || !s) return fail(env, "STATE_HANDLE");
  int ok = 1;
  if (s->lock >= 0) { if (close(s->lock)) ok = 0; s->lock = -1; }
  if (s->dir >= 0) { if (close(s->dir)) ok = 0; s->dir = -1; }
  return ok ? undef(env) : fail(env, "STATE_CLOSE");
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"open", NULL, open_store, NULL, NULL, NULL, napi_default, NULL},
    {"check", NULL, check, NULL, NULL, NULL, napi_default, NULL},
    {"tryLock", NULL, lock_store, NULL, NULL, NULL, napi_default, NULL},
    {"unlock", NULL, unlock_store, NULL, NULL, NULL, napi_default, NULL},
    {"read", NULL, read_store, NULL, NULL, NULL, napi_default, NULL},
    {"write", NULL, write_store, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, close_store, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
