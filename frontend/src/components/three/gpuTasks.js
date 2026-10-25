/**
 * Start-up scheduling for the 3D layer (no three.js import). Everything heavy a scene does before its first frame
 * (building the district, creating the WebGL context, compiling and linking shaders, uploading textures) runs in
 * small pieces between other work, so a page that shows a scene never gets a long main-thread task from it.
 *
 * Why the GPU needs care, not only the CPU: most WebGL calls are queued and return at once, but queries (shader
 * logs, uniform locations, parameters, a new context's first call) wait for the GPU process to finish everything
 * queued before them. If that queue holds a shader link or a first draw, the query blocks the main thread for as
 * long as the driver needs (hundreds of milliseconds on integrated GPUs). So heavy GPU work is issued first, a
 * fence is polled without blocking (`waitForGpu`), and only then does the code make the queries.
 *
 * - nextIdle(): resolves in an idle period (requestIdleCallback with a short timeout: an animated page may have no
 *   idle time for seconds, and start-up must still progress).
 * - nextTask(): yields to the event loop once (scheduler.yield / MessageChannel).
 * - runSliced(iterator): drives a generator in idle slices of a few milliseconds each.
 * - quietFrames(): resolves once a few frames in a row have arrived on time (the compositor and the GPU process are
 *   keeping up), or after a timeout. Used before the few steps that must make a synchronous GPU query (creating a
 *   renderer): while the page is still being painted, such a query waits behind the paint work.
 * - waitForGpu(gl): resolves once the GPU process has executed every command issued so far on `gl`.
 * - gpuQueue(job): runs the heavy GPU steps of every scene on the page one at a time (two canvases never stall
 *   the GPU process together; each step is short, so scenes interleave instead of waiting for each other).
 * - CancelledError / isCancelled(): an AbortSignal stops any of these; the work then rejects with CancelledError.
 */

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class CancelledError extends Error {
  constructor() {
    super('The 3D start-up work was cancelled.')
    this.name = 'CancelledError'
  }
}

export const isCancelled = (error) => error?.name === 'CancelledError'

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError()
}

/** Calls `run(resolve)` and rejects with CancelledError when `signal` aborts first. */
function cancellable(signal, run) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }
    let cleanup = null
    const onAbort = () => {
      cleanup?.()
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    cleanup = run((value) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

/**
 * Resolves with an IdleDeadline-like object `{ didTimeout, timeRemaining() }` in the next idle period, or after
 * `timeout` ms at the latest (Safari has no requestIdleCallback: a short timer stands in).
 */
export function nextIdle({ timeout = 80, signal } = {}) {
  return cancellable(signal, (done) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(done, { timeout })
      return () => window.cancelIdleCallback(handle)
    }
    const start = now()
    const handle = setTimeout(() => done({ didTimeout: false, timeRemaining: () => Math.max(0, 10 - (now() - start)) }), 1)
    return () => clearTimeout(handle)
  })
}

/** Yields to the event loop once (input and rendering get a turn), without waiting for idle time. */
export function nextTask({ signal } = {}) {
  const yielder = typeof globalThis !== 'undefined' ? globalThis.scheduler?.yield : undefined
  if (typeof yielder === 'function') {
    return yielder.call(globalThis.scheduler).then(() => throwIfAborted(signal))
  }
  return cancellable(signal, (done) => {
    if (typeof MessageChannel === 'undefined') {
      const handle = setTimeout(done, 0)
      return () => clearTimeout(handle)
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      done()
    }
    channel.port2.postMessage(null)
    return () => channel.port1.close()
  })
}

/** Resolves after `ms` milliseconds. */
export function delay(ms, { signal } = {}) {
  return cancellable(signal, (done) => {
    const handle = setTimeout(done, ms)
    return () => clearTimeout(handle)
  })
}

/**
 * Runs a generator to completion in idle slices: each slice calls `next()` until about `budget` ms have passed
 * (always at least one step), then waits for the next idle period. Resolves with the generator's return value.
 */
export async function runSliced(iterator, { budget = 8, timeout = 80, signal } = {}) {
  for (;;) {
    const deadline = await nextIdle({ timeout, signal })
    const start = now()
    const idleLeft = deadline && !deadline.didTimeout ? deadline.timeRemaining() : budget
    const limit = Math.max(1, Math.min(budget, idleLeft))
    let step
    do {
      step = iterator.next()
      if (step.done) return step.value
    } while (now() - start < limit)
  }
}

/**
 * Resolves once `frames` consecutive animation frames arrived at most `maxGap` ms apart, or after `timeout` ms
 * (hidden tabs get no frames: the timeout covers them).
 */
export function quietFrames({ frames = 3, maxGap = 25, timeout = 1500, signal } = {}) {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return cancellable(signal, (done) => {
    const start = now()
    let last = 0
    let streak = 0
    let handle = 0
    const timer = setTimeout(() => {
      cancelAnimationFrame(handle)
      done()
    }, timeout)
    const tick = (time) => {
      streak = last && time - last <= maxGap ? streak + 1 : 0
      last = time
      if (streak >= frames || now() - start > timeout) {
        clearTimeout(timer)
        done()
        return
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(handle)
    }
  })
}

/**
 * Resolves (with the wait in ms) once the GPU process has executed every command issued on the WebGL2 context
 * `gl` so far: a fence polled with getSyncParameter, which WebGL answers from a cache updated between tasks, so
 * the poll itself never blocks. Gives up after `timeout` ms (a lost or hung context must not stall start-up).
 */
export function waitForGpu(gl, { signal, timeout = 5000 } = {}) {
  if (!gl || typeof gl.fenceSync !== 'function' || gl.isContextLost()) return Promise.resolve(0)
  const start = now()
  let sync = null
  try {
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
  } catch {
    sync = null
  }
  if (!sync) return Promise.resolve(0)
  const release = () => {
    try {
      gl.deleteSync(sync)
    } catch {
      // The context was lost: nothing to release.
    }
  }
  return cancellable(signal, (done) => {
    let handle = 0
    const poll = () => {
      let signalled
      try {
        signalled = gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED
      } catch {
        signalled = true
      }
      const waited = now() - start
      if (signalled || waited > timeout) {
        release()
        done(waited)
        return
      }
      handle = setTimeout(poll, waited < 40 ? 4 : 12)
    }
    handle = setTimeout(poll, 0)
    return () => {
      clearTimeout(handle)
      release()
    }
  })
}

let queueTail = Promise.resolve()

/**
 * Runs `job` (sync or async) after every job queued before it on this page has settled; resolves or rejects with
 * the job's own result. Keep jobs short (one GPU step plus its fence): the queue is shared by all scenes.
 */
export function gpuQueue(job) {
  const run = queueTail.then(() => job())
  queueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
