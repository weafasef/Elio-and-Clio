'use strict'

/**
 * 修复 uiohook-napi 在 macOS Electron 主进程下的两处死锁缺陷并重编译：
 *
 * 1. src/lib/uiohook_worker.c：
 *    原实现用裸 uv_cond_wait 且在持有 hook_running_mutex 时调 uv_thread_join，
 *    一旦启动阶段发生虚假唤醒就会与后台线程的 EVENT_HOOK_ENABLED 互锁。
 *    修复：增加显式状态位 hook_control_done / hook_is_running，用 while 循环等待，
 *    并在 join 前释放互斥锁。
 *
 * 2. libuiohook/src/darwin/input_hook.c：
 *    去掉未使用的 EVENT_KEY_TYPED 字符翻译和 NX_SYSDEFINED 对主线程的 dispatch_sync_f 调用。
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const pkgDir = path.join(__dirname, '..', 'node_modules', 'uiohook-napi')
const workerFile = path.join(pkgDir, 'src', 'lib', 'uiohook_worker.c')
const hookFile = path.join(pkgDir, 'libuiohook', 'src', 'darwin', 'input_hook.c')
const outNode = path.join(pkgDir, 'prebuilds', `darwin-${process.arch}`, 'uiohook-napi.node')

if (!fs.existsSync(workerFile) || !fs.existsSync(hookFile)) {
  process.exit(0)
}

let workerSrc = fs.readFileSync(workerFile, 'utf8')
let hookSrc = fs.readFileSync(hookFile, 'utf8')
let changed = false

if (!workerSrc.includes('hook_control_done')) {
  workerSrc = workerSrc
    .replace(
      'static uv_cond_t hook_control_cond;',
      'static uv_cond_t hook_control_cond;\nstatic bool hook_control_done = false;\nstatic bool hook_is_running = false;',
    )
    .replace(
      `  case EVENT_HOOK_ENABLED:
    // Lock the running mutex so we know if the hook is enabled.
    uv_mutex_lock(&hook_running_mutex);

    // Signal control cond so hook_enable() can continue.
    uv_mutex_lock(&hook_control_mutex);
    uv_cond_signal(&hook_control_cond);
    uv_mutex_unlock(&hook_control_mutex);
    break;

  case EVENT_HOOK_DISABLED:
    // Lock the control mutex until we exit.
    uv_mutex_lock(&hook_control_mutex);

    // Unlock the running mutex so we know if the hook is disabled.
    uv_mutex_unlock(&hook_running_mutex);
    break;`,
      `  case EVENT_HOOK_ENABLED:
    // Signal control cond so hook_enable() can continue.
    uv_mutex_lock(&hook_control_mutex);
    hook_is_running = true;
    hook_control_done = true;
    uv_cond_signal(&hook_control_cond);
    uv_mutex_unlock(&hook_control_mutex);
    break;

  case EVENT_HOOK_DISABLED:
    uv_mutex_lock(&hook_control_mutex);
    hook_is_running = false;
    uv_mutex_unlock(&hook_control_mutex);
    break;`,
    )
    .replace(
      `  // Set the hook status.
  hook_thread_status = hook_run();

  // Make sure we signal that we have passed any exception throwing code for
  // the waiting hook_enable().
  uv_cond_signal(&hook_control_cond);
  uv_mutex_unlock(&hook_control_mutex);
}

int hook_enable() {
  // Lock the thread control mutex.  This will be unlocked when the
  // thread has finished starting, or when it has fully stopped.
  uv_mutex_lock(&hook_control_mutex);

  // Set the initial status.
  int status = UIOHOOK_FAILURE;

  if (uv_thread_create(&hook_thread, hook_thread_proc, NULL) == 0) {
    // Wait for the thread to indicate that it has passed the 
    // initialization portion by blocking until either a EVENT_HOOK_ENABLED 
    // event is received or the thread terminates.
    uv_cond_wait(&hook_control_cond, &hook_control_mutex);

    if (uv_mutex_trylock(&hook_running_mutex) == 0) {
      // Lock Successful; The hook is not running but the hook_control_cond 
      // was signaled!  This indicates that there was a startup problem!

      // Get the status back from the thread.
      uv_thread_join(&hook_thread);
      status = hook_thread_status;
      uv_mutex_unlock(&hook_running_mutex);
    }
    else {
      // Lock Failure; The hook is currently running and wait was signaled
      // indicating that we have passed all possible start checks.  We can 
      // always assume a successful startup at this point.
      status = UIOHOOK_SUCCESS;
    }

    logger_proc(LOG_LEVEL_DEBUG, "%s [%u]: Thread Result: (%#X).\\n",
      __FUNCTION__, __LINE__, status);
  }
  else {
    status = UIOHOOK_ERROR_THREAD_CREATE;
  }

  // Make sure the control mutex is unlocked.
  uv_mutex_unlock(&hook_control_mutex);

  return status;
}`,
      `  // Set the hook status.
  hook_thread_status = hook_run();

  // Make sure we signal that we have passed any exception throwing code for
  // the waiting hook_enable().
  uv_mutex_lock(&hook_control_mutex);
  hook_is_running = false;
  hook_control_done = true;
  uv_cond_signal(&hook_control_cond);
  uv_mutex_unlock(&hook_control_mutex);
}

int hook_enable() {
  // Lock the thread control mutex.  This will be unlocked when the
  // thread has finished starting, or when it has fully stopped.
  uv_mutex_lock(&hook_control_mutex);
  hook_control_done = false;
  hook_is_running = false;

  // Set the initial status.
  int status = UIOHOOK_FAILURE;

  if (uv_thread_create(&hook_thread, hook_thread_proc, NULL) == 0) {
    // Wait for the thread to indicate that it has passed the 
    // initialization portion by blocking until either a EVENT_HOOK_ENABLED 
    // event is received or the thread terminates.
    while (!hook_control_done) {
      uv_cond_wait(&hook_control_cond, &hook_control_mutex);
    }

    if (!hook_is_running) {
      // The hook is not running but the hook_control_cond was signaled!
      // Unlock before joining so the worker thread can never deadlock.
      uv_mutex_unlock(&hook_control_mutex);
      uv_thread_join(&hook_thread);
      status = hook_thread_status;
      return status;
    }
    else {
      status = UIOHOOK_SUCCESS;
    }

    logger_proc(LOG_LEVEL_DEBUG, "%s [%u]: Thread Result: (%#X).\\n",
      __FUNCTION__, __LINE__, status);
  }
  else {
    status = UIOHOOK_ERROR_THREAD_CREATE;
  }

  // Make sure the control mutex is unlocked.
  uv_mutex_unlock(&hook_control_mutex);

  return status;
}`,
    )
  fs.writeFileSync(workerFile, workerSrc, 'utf8')
  changed = true
}

if (hookSrc.includes('CGEventMaskBit(NX_SYSDEFINED)')) {
  hookSrc = hookSrc.replace(
    `            CGEventMaskBit(kCGEventMouseMoved) |
            CGEventMaskBit(kCGEventScrollWheel) |

            // NOTE This event is undocumented and used
            // for caps-lock release and multi-media keys.
            CGEventMaskBit(NX_SYSDEFINED);`,
    `            CGEventMaskBit(kCGEventMouseMoved) |
            CGEventMaskBit(kCGEventScrollWheel);`,
  )
  const startMarker = '    // Fire key pressed event.\n    dispatch_event(&event);\n'
  const endMarker = '\nstatic inline void process_key_released'
  const startIdx = hookSrc.indexOf(startMarker)
  const endIdx = hookSrc.indexOf(endMarker)
  if (startIdx >= 0 && endIdx > startIdx) {
    hookSrc = hookSrc.slice(0, startIdx + startMarker.length) + '}\n' + hookSrc.slice(endIdx)
  }
  fs.writeFileSync(hookFile, hookSrc, 'utf8')
  changed = true
}

function findNodeInclude() {
  const candidates = [
    path.join(os.homedir(), 'Library', 'Caches', 'node-gyp', process.versions.node, 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ]
  const gypDir = path.join(os.homedir(), 'Library', 'Caches', 'node-gyp')
  if (fs.existsSync(gypDir)) {
    for (const ver of fs.readdirSync(gypDir)) {
      candidates.push(path.join(gypDir, ver, 'include', 'node'))
    }
  }
  return candidates.find(dir => fs.existsSync(path.join(dir, 'node_api.h')) && fs.existsSync(path.join(dir, 'uv.h')))
}

if (changed || process.argv.includes('--rebuild')) {
  const nodeInclude = findNodeInclude()
  if (!nodeInclude) {
    console.warn('[patch-uiohook] 未找到 node_api.h / uv.h，跳过编译')
    process.exit(0)
  }

  const res = spawnSync(
    '/usr/bin/clang',
    [
      '-bundle', '-undefined', 'dynamic_lookup', '-fPIC', '-O2', '-pthread',
      '-D__MACOSX_CORE__', '-DUSE_IOKIT', '-DUSE_APPLICATION_SERVICES', '-DUSE_OBJC', '-DBUILDING_NODE_EXTENSION',
      `-I${nodeInclude}`,
      '-Ilibuiohook/include', '-Ilibuiohook/src', '-Ilibuiohook/src/darwin', '-Isrc/lib',
      'src/lib/addon.c',
      'src/lib/napi_helpers.c',
      'src/lib/uiohook_worker.c',
      'libuiohook/src/logger.c',
      'libuiohook/src/darwin/input_helper.c',
      'libuiohook/src/darwin/input_hook.c',
      'libuiohook/src/darwin/post_event.c',
      'libuiohook/src/darwin/system_properties.c',
      '-framework', 'IOKit',
      '-framework', 'Carbon',
      '-framework', 'ApplicationServices',
      '-framework', 'AppKit',
      '-framework', 'CoreFoundation',
      '-o', outNode,
    ],
    { cwd: pkgDir, stdio: 'inherit' },
  )
  if (res.status !== 0) process.exit(res.status ?? 1)
  spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', outNode], { stdio: 'inherit' })
}
