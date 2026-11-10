/* polycarp_core.h: C ABI over the Polycarp voice engine (Rust crate polycarp-core).
 *
 * Rules for every call:
 *  - No panic crosses this boundary. A panic becomes the failure value below.
 *  - int calls return 0 on success or a negative PC_ERR_* code. char * calls return NULL
 *    on failure. The reason is pc_last_error() on the same thread.
 *  - Strings in are NUL-terminated UTF-8, borrowed for the call. Strings out are owned by the
 *    caller and released with pc_string_free.
 *  - A PcCore * may be used from any thread at once. Callbacks may run on any thread, even
 *    while the engine holds a short lock: return quickly, copy what you need, never call
 *    back into this library from inside a callback.
 *  - The data folder is process-wide: open one handle per process.
 */
#ifndef POLYCARP_CORE_H
#define POLYCARP_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PC_ABI_VERSION 1u

#define PC_OK 0
#define PC_ERR_ARG (-1)    /* a NULL or non-UTF-8 argument */
#define PC_ERR_FAILED (-2) /* the operation failed; see pc_last_error() */
#define PC_ERR_PANIC (-3)  /* an internal error was caught */

/* pc_open flag: no global key listener and no background device pick (tests, tools). */
#define PC_HEADLESS 1u

typedef struct PcCore PcCore;

/* Events: "status", "transcript", "learned", "model-progress", "benchmark-progress",
 * "benchmark-done", "benchmark-error", "show-main", "listener-returned", "notice". `json` is the
 * payload. "notice" is {kind, message}: kind "error" (a dictation failed; status turns error for a
 * few seconds), "busy" (a press came while Silas was busy), or "stopped" (Escape stopped typing;
 * the full text is in History). */
typedef void (*PcEventFn)(void *user, const char *event, const char *json);
/* Microphone level, 0..1, many times a second while recording. */
typedef void (*PcLevelFn)(void *user, float level);

/* The ABI version this library was built with. */
uint32_t pc_abi_version(void);
/* Message for the last failure on this thread ("" if none). Valid until the next call on this
 * thread. Do not free. */
const char *pc_last_error(void);
/* Release a string returned by this library. NULL is fine. */
void pc_string_free(char *s);

/* Create the engine. Nothing runs yet: call pc_start. `data_dir` holds settings, dictionary,
 * history and models (created if missing). `user` must be usable from any thread. Either
 * callback may be NULL. Returns NULL on failure. */
PcCore *pc_open(const char *data_dir, uint32_t flags, PcEventFn on_event, PcLevelFn on_level,
                void *user);
/* Free the handle. Not safe to use it afterward. */
void pc_close(PcCore *core);

/* Start or resume dictation: load the chosen model, pick one for this device if none is set,
 * listen for the hotkey. Safe to call again. Never unloads the model. */
int pc_start(const PcCore *core);
/* Pause dictation: drop a recording in progress and ignore the hotkey. The model stays loaded. */
int pc_stop(const PcCore *core);
/* Start or finish a dictation from a button, as a tap on the hotkey would. */
int pc_toggle_recording(const PcCore *core);

/* JSON {status, detail, model, hotkey, hotkeyLabel, enabled, listener, permissions}.
 * status: loading | needs_model | ready | recording | transcribing | typing | error. */
char *pc_status(const PcCore *core);

/* Settings as JSON (camelCase: hotkey, tapToToggle, model, language, ...). */
char *pc_settings_get(const PcCore *core);
/* Replace the settings with JSON of the same shape. The model and its source are kept (use
 * pc_model_select). The hotkey must parse. Returns the stored settings, or NULL. */
char *pc_settings_set(const PcCore *core, const char *json);
/* Wait up to timeout_ms for the user to press the key to use as hotkey; returns its name, or
 * NULL with the reason in pc_last_error(): "No key pressed" on timeout, "cancelled" after Escape
 * or pc_hotkey_capture_cancel, or a sentence when the key types text (letters, digits, Space,
 * Return, Tab, Delete). Blocks: call off the main thread. */
char *pc_hotkey_capture(const PcCore *core, uint32_t timeout_ms);
/* End a pc_hotkey_capture in progress (it returns NULL with "cancelled"). PC_ERR_FAILED if none
 * was running. */
int pc_hotkey_capture_cancel(const PcCore *core);
/* JSON array of microphone names. Never opens a microphone. */
char *pc_microphones(void);

/* JSON array of models (id, name, size, installed, active, ...). */
char *pc_models_list(const PcCore *core);
/* Choose an installed model and load it. auto != 0 when setup picks for the user. */
int pc_model_select(const PcCore *core, const char *id, int auto_pick);
/* Download a model. Blocks; progress arrives as "model-progress" events. Call off the main
 * thread. Each file is checked against its published SHA-256 before the model counts as
 * installed; a read that waits 30 s without a byte fails. After pc_model_download_cancel it
 * returns PC_ERR_FAILED with "cancelled", the last event's stage is "cancelled", and nothing is
 * left on disk. */
int pc_model_download(const PcCore *core, const char *id);
/* Stop a pc_model_download of id in progress. PC_ERR_FAILED if that model isn't downloading. */
int pc_model_download_cancel(const PcCore *core, const char *id);
/* Delete a downloaded model. Refuses while it is the active one. */
int pc_model_delete(const PcCore *core, const char *id);

/* Dictionary (terms, corrections, pending) as JSON. */
char *pc_dictionary_get(const PcCore *core);
/* Merge an exported dictionary (JSON) in and save. Returns the new dictionary. */
char *pc_dictionary_import(const PcCore *core, const char *json);
char *pc_dictionary_add_term(const PcCore *core, const char *term);
char *pc_dictionary_remove_term(const PcCore *core, const char *term);
char *pc_dictionary_add_correction(const PcCore *core, const char *from, const char *to);
char *pc_dictionary_remove_correction(const PcCore *core, const char *from);

/* The newest `limit` dictations as JSON (0 means all kept). */
char *pc_history_get(const PcCore *core, uint32_t limit);
int pc_history_delete(const PcCore *core, const char *id);
int pc_history_clear(const PcCore *core);

#ifdef __cplusplus
}
#endif

#endif /* POLYCARP_CORE_H */
