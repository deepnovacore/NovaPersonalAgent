#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <delayimp.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
typedef intptr_t(__cdecl *nova_uv_get_osfhandle_fn)(int);
typedef struct { HANDLE handle; OVERLAPPED range; } nova_lock_handle;
static FARPROC WINAPI nova_delay_load_hook(unsigned notification,
                                           PDelayLoadInfo information) {
  if (notification == dliNotePreLoadLibrary && information != NULL &&
      information->szDll != NULL &&
      _stricmp(information->szDll, "node.exe") == 0) {
#pragma warning(push)
#pragma warning(disable : 4055)
    return (FARPROC)(void *)GetModuleHandleW(NULL);
#pragma warning(pop)
  }
  return NULL;
}
const PfnDliHook __pfnDliNotifyHook2 = nova_delay_load_hook;
static int nova_handle_from_value(napi_env env, napi_value value,
                                  HANDLE *output) {
  int32_t descriptor = -1;
  if (napi_get_value_int32(env, value, &descriptor) != napi_ok ||
      descriptor < 0)
    return 0;
  HMODULE executable = GetModuleHandleW(NULL);
  if (executable == NULL)
    return 0;
#pragma warning(push)
#pragma warning(disable : 4055)
  nova_uv_get_osfhandle_fn get_os_handle =
      (nova_uv_get_osfhandle_fn)(void *)GetProcAddress(executable,
                                                     "uv_get_osfhandle");
#pragma warning(pop)
  if (get_os_handle == NULL)
    return 0;
  intptr_t raw = get_os_handle(descriptor);
  if (raw == -1)
    return 0;
  *output = (HANDLE)raw;
  return *output != NULL && *output != INVALID_HANDLE_VALUE;
}

/* OS advisory locks are released after a crash; never unlink the lock file. */
static napi_value nova_status(napi_env env, const char *status) {
  napi_value result;
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value) !=
          napi_ok ||
      napi_set_named_property(env, result, "status", value) != napi_ok)
    return NULL;
  return result;
}

static int nova_args(napi_env env, napi_callback_info info, size_t expected,
                     napi_value *args) {
  size_t count = expected;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok)
    return 0;
  return count == expected;
}

static void nova_release_lock(nova_lock_handle *lock) {
  if (lock == NULL || lock->handle == NULL ||
      lock->handle == INVALID_HANDLE_VALUE)
    return;
  HANDLE handle = lock->handle;
  lock->handle = INVALID_HANDLE_VALUE;
  (void)UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &lock->range);
  CloseHandle(handle);
}

static void nova_lock_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  nova_lock_handle *lock = (nova_lock_handle *)data;
  nova_release_lock(lock);
  free(lock);
}

static napi_value nova_lock_release(napi_env env, napi_callback_info info) {
  void *data = NULL;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, NULL, NULL, &data) == napi_ok) {
    nova_release_lock((nova_lock_handle *)data);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok)
    return NULL;
  return undefined;
}

static napi_value nova_acquire(napi_env env, napi_callback_info info) {
  napi_value args[1];
  HANDLE borrowed;
  BY_HANDLE_FILE_INFORMATION file;
  if (!nova_args(env, info, 1, args) ||
      !nova_handle_from_value(env, args[0], &borrowed) ||
      !GetFileInformationByHandle(borrowed, &file) ||
      (file.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0)
    return nova_status(env, "failed");
  HANDLE retained = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), borrowed, GetCurrentProcess(),
                       &retained, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return nova_status(env, "failed");
  nova_lock_handle *lock = (nova_lock_handle *)calloc(1, sizeof(*lock));
  if (lock == NULL) {
    CloseHandle(retained);
    return nova_status(env, "failed");
  }
  lock->handle = retained;
  ZeroMemory(&lock->range, sizeof(lock->range));
  if (!LockFileEx(retained, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                  0, MAXDWORD, MAXDWORD, &lock->range)) {
    DWORD error = GetLastError();
    CloseHandle(retained);
    free(lock);
    return nova_status(env, error == ERROR_LOCK_VIOLATION ||
                                    error == ERROR_IO_PENDING
                                ? "busy"
                                : "failed");
  }
  napi_value result = nova_status(env, "acquired");
  napi_value release;
  napi_value owner;
  if (result == NULL ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, nova_lock_release,
                           lock, &release) != napi_ok ||
      napi_create_external(env, lock, nova_lock_finalize, NULL, &owner) !=
          napi_ok) {
    nova_release_lock(lock);
    free(lock);
    return nova_status(env, "failed");
  }
  if (napi_set_named_property(env, release, "__nova_lock_owner", owner) !=
          napi_ok ||
      napi_set_named_property(env, result, "release", release) != napi_ok)
    return nova_status(env, "failed");
  return result;
}

static int nova_export(napi_env env, napi_value exports, const char *name,
                       napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL,
                              &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
  if (!nova_export(env, exports, "acquire", nova_acquire)) return NULL;
  return exports;
}
