// Diagnostics are an allowlist projection: never serialize exceptions or output.
const stages = new Set(['MOCK_CHECK', 'FIXTURE_CREATE', 'NEXT_START', 'PROXY_LISTEN', 'EVENTS_HTTP', 'CLEANUP'])
const codes = new Set(['EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'PROBE_RESPONSE_TOO_LARGE', 'PROBE_RESPONSE_INVALID'])
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP'])
const classifications = new Set(['UNKNOWN_STARTUP_FAILURE', 'PORT_IN_USE', 'DEPENDENCY_ERROR', 'COMPILE_ERROR', 'NEXT_STARTUP_ERROR', 'STARTUP_TIMEOUT', 'CHILD_EARLY_EXIT', 'MOCK_NOT_APPLIED', 'HTTP_ERROR', 'CLEANUP_FAILED'])
export function safeCommunicationCode(error) {
  if (codes.has(error?.code)) return error.code
  if (codes.has(error?.cause?.code)) return error.cause.code
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'ETIMEDOUT'
  return null
}
export function safeDiagnostic(value) {
  return {
    stage: stages.has(value.stage) ? value.stage : 'NEXT_START',
    outcome: ['passed', 'failed', 'observed'].includes(value.outcome) ? value.outcome : 'failed',
    classification: classifications.has(value.classification) ? value.classification : null,
    child_exit_code: Number.isInteger(value.child_exit_code) && value.child_exit_code >= 0 && value.child_exit_code <= 255 ? value.child_exit_code : null,
    child_exit_signal: signals.has(value.child_exit_signal) ? value.child_exit_signal : null,
    http_status: Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599 ? value.http_status : null,
    communication_code: codes.has(value.communication_code) ? value.communication_code : null,
    next_error: ['DEPENDENCY_ERROR', 'COMPILE_ERROR', 'NEXT_STARTUP_ERROR'].includes(value.next_error) ? value.next_error : null,
  }
}
export function classifyNextOutput(line) {
  if (/Module not found|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|Cannot load native addon|Failed to load SWC binary/i.test(line)) return 'DEPENDENCY_ERROR'
  if (/Failed to compile|Module build failed|SyntaxError:|Type error:|Parsing ecmascript source code failed/i.test(line)) return 'COMPILE_ERROR'
  if (/Failed to start server|Failed to load next\.config|Invalid next\.config|requires Node\.js version/i.test(line)) return 'NEXT_STARTUP_ERROR'
  return null
}
// Keep only a bounded, incomplete line in memory; output is never retained/logged.
export function observeNextOutput(stream, observe) {
  let pending = ''
  const consume = chunk => {
    const parts = (pending + String(chunk).replace(/\x1b\[[0-9;]*m/g, '')).split(/[\r\n]/)
    pending = parts.pop().slice(-4096)
    for (const line of parts) { const classification = classifyNextOutput(line); if (classification) observe(classification) }
  }
  const finish = () => { const classification = classifyNextOutput(pending); pending = ''; if (classification) observe(classification) }
  stream?.on('data', consume); stream?.on('end', finish)
  return () => { finish(); stream?.off('data', consume); stream?.off('end', finish) }
}

// All effects are injected by the CLI, never by an HTTP request.
export async function startBrowserTest(deps, { attempts = 80 } = {}) {
  let stage = 'MOCK_CHECK', directory, child, proxy, nextError = null, childError = null
  let exitCode = null, exitSignal = null, exited = false, lastStatus = null, lastCommunication = null
  let closing, removeObservers = []
  const report = value => deps.report(safeDiagnostic(value))
  const cleanup = () => closing ??= (async () => {
    let failed = false
    if (proxy) { try { await proxy.close() } catch { failed = true } }
    if (child) { try { await deps.stopChild(child) } catch { failed = true } }
    for (const remove of removeObservers) remove()
    if (directory) { try { await deps.removeFixture(directory) } catch { failed = true } }
    if (failed) report({stage:'CLEANUP',outcome:'failed',classification:'CLEANUP_FAILED'})
    return !failed
  })()
  const childFailed = () => exited || childError !== null
  try {
    await deps.verifyMock()
    report({stage,outcome:'passed'})
    stage = 'FIXTURE_CREATE'; directory = await deps.prepare()
    report({stage,outcome:'passed'})
    stage = 'NEXT_START'
    const internalPort = await deps.reservePort()
    child = deps.spawn(directory, internalPort)
    const onExit = (code, signal) => {
      exited = true; exitCode = code; exitSignal = signal
    }
    const onError = error => { childError = error }
    child.on('exit', onExit); child.on('error', onError)
    const observe = classification => { nextError = classification }
    removeObservers = [observeNextOutput(child.stdout, observe), observeNextOutput(child.stderr, observe)]
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (childFailed()) throw new Error()
    report({stage,outcome:'passed'})
    stage = 'MOCK_CHECK'; proxy = deps.createProxy(internalPort)
    await proxy.checkMock()
    report({stage,outcome:'passed'})
    stage = 'PROXY_LISTEN'; await proxy.listen()
    report({stage,outcome:'passed'})
    stage = 'EVENTS_HTTP'
    let ready = false
    for (let index = 0; index < attempts; index++) {
      if (childFailed()) throw new Error()
      try {
        const response = await deps.fetchEvents(internalPort)
        lastStatus = response.status
        lastCommunication = null
        // Do not read or log HTML: it can include source excerpts.
        await response.body?.cancel()
        report({stage,outcome:'observed',http_status:lastStatus})
        if (response.ok) { ready = true; break }
        if (lastStatus >= 400) throw Object.assign(new Error(), { startupHttpFailure: true })
      } catch (error) {
        if (error?.startupHttpFailure) throw error
        lastCommunication = safeCommunicationCode(error)
      }
      await deps.pause()
    }
    if (childFailed()) throw new Error()
    if (!ready) throw Object.assign(new Error(), { startupTimeout: true })
    report({stage,outcome:'passed',http_status:lastStatus})
    stage = 'MOCK_CHECK'; await proxy.probeMock()
    if (childFailed()) throw new Error()
    report({stage,outcome:'passed'})
    // Monitor an unexpected exit after readiness as well as during startup.
    child.on('exit', () => {
      if (!closing) {
        report({stage:'NEXT_START',outcome:'failed',classification:nextError ?? 'CHILD_EARLY_EXIT',child_exit_code:exitCode,child_exit_signal:exitSignal,next_error:nextError})
        deps.onUnexpectedExit?.()
        void cleanup()
      }
    })
    return {ok:true,cleanup,summary:proxy.summary}
  } catch (error) {
    // Flush an unterminated diagnostic line before selecting a classification.
    for (const remove of removeObservers) remove()
    const communication = safeCommunicationCode(childError ?? error) ?? lastCommunication
    const classification = stage === 'MOCK_CHECK' ? 'MOCK_NOT_APPLIED'
      : communication === 'EADDRINUSE' ? 'PORT_IN_USE'
      : nextError ?? (childError ? 'NEXT_STARTUP_ERROR' : exited ? 'CHILD_EARLY_EXIT' : error?.startupTimeout ? 'STARTUP_TIMEOUT' : error?.startupHttpFailure ? 'HTTP_ERROR' : 'UNKNOWN_STARTUP_FAILURE')
    report({stage,outcome:'failed',classification,child_exit_code:exitCode,child_exit_signal:exitSignal,http_status:stage==='EVENTS_HTTP'?lastStatus:error?.startupHttpStatus,communication_code:communication,next_error:nextError})
    await cleanup()
    return {ok:false,cleanup}
  }
}
