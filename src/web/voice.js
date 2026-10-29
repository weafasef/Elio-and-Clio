/**
 * 按住说话：录音 → 16k 单声道 WAV → /asr → 文字。
 *
 * 不负责发送。调用方拿到文字后自己决定怎么用。
 * 这个模块不绑定按钮；键盘、按钮都可以调用 start() / stop()。
 */

const DEFAULT_MAX_MS = 60_000
const DEFAULT_MIN_MS = 300

export function createVoiceInput(options = {}) {
  const {
    onResult,
    onState,
    onError,
    maxMs = DEFAULT_MAX_MS,
    minMs = DEFAULT_MIN_MS,
  } = options

  let recorder = null
  let stream = null
  let chunks = []
  let startedAt = 0
  let maxTimer = 0
  let want = false
  let starting = false
  let recording = false
  let busy = false
  let discard = false

  function setState(state, text) {
    try {
      onState?.(state, text)
    } catch {
      // 状态回调不能影响录音
    }
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error)
    setState('idle', '')
    try {
      onError?.(message)
    } catch {
      // 忽略
    }
  }

  async function start() {
    if (busy || starting || recording) return
    if (!navigator.mediaDevices?.getUserMedia) {
      fail(new Error('当前环境不支持麦克风'))
      return
    }

    want = true
    starting = true
    discard = false
    setState('starting', '正在打开麦克风…')

    try {
      if (window.ehPet?.requestMicrophone) {
        const allowed = await window.ehPet.requestMicrophone()
        if (!allowed) throw new Error('麦克风权限被拒绝，请到系统设置里允许')
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      if (!want) {
        stopStream()
        starting = false
        setState('idle', '已取消')
        return
      }

      const mimeType = pickMimeType()
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunks = []
      recorder.ondataavailable = event => {
        if (event.data?.size) chunks.push(event.data)
      }
      recorder.onerror = event => {
        const error = event?.error instanceof Error ? event.error : new Error('录音失败')
        cleanupRecorder()
        busy = false
        recording = false
        starting = false
        fail(error)
      }
      recorder.onstop = () => {
        void finish()
      }

      recorder.start(100)
      startedAt = performance.now()
      starting = false
      recording = true
      busy = true
      setState('recording', '🎙 录音中…')
      maxTimer = setTimeout(() => stop(), maxMs)
    } catch (error) {
      const canceled = !want
      want = false
      starting = false
      recording = false
      busy = false
      stopStream()
      cleanupRecorder()
      if (canceled) setState('idle', '已取消')
      else fail(error)
    }
  }

  function stop() {
    want = false
    if (starting) {
      setState('idle', '已取消')
      return
    }
    if (!recording || !recorder) return

    recording = false
    clearTimeout(maxTimer)
    maxTimer = 0
    setState('transcribing', '… 识别中')

    try {
      recorder.stop()
    } catch (error) {
      cleanupRecorder()
      busy = false
      fail(error)
    }
  }

  /** 放弃当前录音，不发送 */
  function cancel() {
    want = false
    if (starting) {
      starting = false
      stopStream()
      setState('idle', '已取消')
      return
    }
    if (!recording || !recorder) return

    discard = true
    recording = false
    clearTimeout(maxTimer)
    maxTimer = 0
    try {
      recorder.stop()
    } catch {
      cleanupRecorder()
      busy = false
      setState('idle', '已取消')
    }
  }

  async function finish() {
    clearTimeout(maxTimer)
    maxTimer = 0
    const duration = performance.now() - startedAt
    const type = recorder?.mimeType || 'audio/webm'
    const blob = new Blob(chunks, { type })
    cleanupRecorder()

    if (discard || duration < minMs || blob.size === 0) {
      busy = false
      setState('idle', discard ? '已取消' : '太短了，没有发送')
      return
    }

    try {
      const wav = await decodeToWav(blob)
      const response = await fetch('/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `识别失败（HTTP ${response.status}）`)
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      if (!text) throw new Error('没有识别到声音')

      setState('idle', '')
      await onResult?.(text)
    } catch (error) {
      fail(error)
    } finally {
      busy = false
    }
  }

  function cleanupRecorder() {
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      recorder = null
    }
    chunks = []
    stopStream()
  }

  function stopStream() {
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // 忽略
        }
      }
      stream = null
    }
  }

  return {
    start,
    stop,
    cancel,
    get recording() {
      return recording
    },
    get busy() {
      return busy || starting
    },
  }
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type
    } catch {
      // 继续试
    }
  }
  return ''
}

async function decodeToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioCtor) throw new Error('浏览器不支持音频解码')

  const context = new AudioCtor()
  let decoded
  try {
    decoded = await context.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    await context.close().catch(() => undefined)
  }

  const targetRate = 16_000
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext

  if (OfflineCtor) {
    const offline = new OfflineCtor(1, frames, targetRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0)
    const rendered = await offline.startRendering()
    return encodeWav(rendered.getChannelData(0), targetRate)
  }

  return encodeWav(resampleLinear(decoded.getChannelData(0), decoded.sampleRate, targetRate), targetRate)
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const length = Math.max(1, Math.round(input.length * toRate / fromRate))
  const output = new Float32Array(length)
  const ratio = fromRate / toRate
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    output[i] = a + (b - a) * fraction
  }
  return output
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
