#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
typedef struct { int descriptor; } nova_lock_handle;

/* OS advisory locks are released after a crash; never unlink the lock file. */
static napi_value nova_status(napi_env env, const char* status) {
  napi_value result;
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "status", value) != napi_ok) {
    return NULL;
  }
  return result;
}

static int nova_descriptor(napi_env env, napi_value value, int* descriptor) {
  int32_t candidate;
  if (napi_get_value_int32(env, value, &candidate) != napi_ok || candidate < 0) return 0;
  *descriptor = (int)candidate;
  return 1;
}

static int nova_args(
    napi_env env,
    napi_callback_info info,
    size_t expected,
    napi_value* args) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok) return 0;
  return count == expected;
}

static void nova_release_lock(nova_lock_handle* handle) {
  if (handle == NULL || handle->descriptor < 0) return;
  int descriptor = handle->descriptor;
  handle->descriptor = -1;
  (void)flock(descriptor, LOCK_UN);
  (void)close(descriptor);
}

static void nova_lock_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  nova_lock_handle* handle = (nova_lock_handle*)data;
  nova_release_lock(handle);
  free(handle);
}

static napi_value nova_lock_release(napi_env env, napi_callback_info info) {
  void* data = NULL;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, NULL, NULL, &data) == napi_ok) {
    nova_release_lock((nova_lock_handle*)data);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
  return undefined;
}

static napi_value nova_acquire(napi_env env, napi_callback_info info) {
  napi_value args[1];
  int descriptor;
  struct stat descriptor_info;
  if (!nova_args(env, info, 1, args) || !nova_descriptor(env, args[0], &descriptor) ||
      fstat(descriptor, &descriptor_info) != 0 || !S_ISREG(descriptor_info.st_mode) ||
      descriptor_info.st_uid != geteuid()) return nova_status(env, "failed");
  int retained = dup(descriptor);
  if (retained < 0) return nova_status(env, "failed");
  if (flock(retained, LOCK_EX | LOCK_NB) != 0) {
    int lock_error = errno;
    (void)close(retained);
    return nova_status(env, lock_error == EWOULDBLOCK || lock_error == EAGAIN ? "busy" : "failed");
  }

  nova_lock_handle* handle = (nova_lock_handle*)calloc(1, sizeof(nova_lock_handle));
  if (handle == NULL) {
    (void)flock(retained, LOCK_UN);
    (void)close(retained);
    return nova_status(env, "failed");
  }
  handle->descriptor = retained;
  napi_value result = nova_status(env, "acquired");
  napi_value release;
  napi_value owner;
  if (result == NULL ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, nova_lock_release, handle, &release) != napi_ok ||
      napi_create_external(env, handle, nova_lock_finalize, NULL, &owner) != napi_ok) {
    nova_release_lock(handle);
    free(handle);
    return nova_status(env, "failed");
  }
  /* From this point the external owns the handle even if property attachment fails. */
  if (napi_set_named_property(env, release, "__nova_lock_owner", owner) != napi_ok ||
      napi_set_named_property(env, result, "release", release) != napi_ok) return nova_status(env, "failed");
  return result;
}

static int nova_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) == napi_ok &&
      napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
  if (!nova_export(env, exports, "acquire", nova_acquire)) return NULL;
  return exports;
}
