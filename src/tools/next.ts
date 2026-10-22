import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTool } from '../registries/tools.ts'
import { loadConfig } from '../config.ts'

/**
 * 读书的三个工具。
 *
 *   next()        下一章
 *   goto(n)       跳到第 n 章
 *   back()        回到上一章（复习用）
 *
 * 数据来自 config.bookFile，按 `===== 001 标题 =====` 切章。
 * 进度写在 <dataDir>/reading.json：index = 下一章的下标（0 起）。
 */

type Chapter = { number: string, title: string, text: string }

type Progress = { file: string, index: number }

const HEAD = /^=====\s*(\d+)\s+(.*?)\s*=====$/

function bookFile(): string {
  const file = loadConfig().bookFile
  if (!file) throw new Error('没有配置要读的书（config.bookFile）')
  return file
}

function chaptersOf(file: string): Chapter[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const chapters: Chapter[] = []
  let current: Chapter | null = null

  for (const raw of lines) {
    const line = raw.trimEnd()
    const matched = HEAD.exec(line)
    if (matched) {
      if (current) chapters.push(current)
      current = { number: matched[1]!, title: matched[2]!, text: '' }
      continue
    }
    if (current) current.text += line + '\n'
  }
  if (current) chapters.push(current)

  return chapters.map(chapter => ({ ...chapter, text: chapter.text.trim() }))
}

function progressFile(dataDir: string): string {
  return join(dataDir, 'reading.json')
}

function readIndex(dataDir: string, file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(progressFile(dataDir), 'utf8')) as Progress
    if (parsed.file === file && Number.isInteger(parsed.index) && parsed.index >= 0) return parsed.index
  } catch {
    // 文件没有 / 换书了，从头开始
  }
  return 0
}

function saveIndex(dataDir: string, file: string, index: number): void {
  writeFileSync(progressFile(dataDir), JSON.stringify({ file, index }, null, 2) + '\n', 'utf8')
}

function show(chapter: Chapter, position: number, total: number): string {
  return `【第 ${position} / ${total} 章】${chapter.title}\n\n${chapter.text}`
}

registerTool({
  name: 'next',
  description: '读下一章书。读完一章再叫一次，就看下一章；全书读完后再叫，会告诉你没有了。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const file = bookFile()
    const chapters = chaptersOf(file)
    if (chapters.length === 0) throw new Error(`这本书里没有章节：${file}`)

    const index = readIndex(ctx.dataDir, file)
    if (index >= chapters.length) {
      return `没有下一章了：${chapters.length} 章都读完了。可以 sleep() 了。`
    }

    saveIndex(ctx.dataDir, file, index + 1)
    return show(chapters[index]!, index + 1, chapters.length)
  },
})

registerTool({
  name: 'goto',
  description: '跳到指定的第几章。跳过去之后，next() 会从它的下一章继续。',
  parameters: {
    type: 'object',
    properties: {
      chapter: {
        type: 'integer',
        description: '第几章，从 1 开始',
      },
    },
    required: ['chapter'],
  },
  run(args, ctx) {
    const file = bookFile()
    const chapters = chaptersOf(file)
    const wanted = Number(args.chapter)

    if (!Number.isInteger(wanted) || wanted < 1 || wanted > chapters.length) {
      throw new Error(`章节号要在 1 ~ ${chapters.length} 之间`)
    }

    saveIndex(ctx.dataDir, file, wanted)
    return show(chapters[wanted - 1]!, wanted, chapters.length)
  },
})

registerTool({
  name: 'back',
  description: '回到上一章再看一遍（复习）。看完 next() 会回到刚才那一章。',
  parameters: {
    type: 'object',
    properties: {},
  },
  run(_args, ctx) {
    const file = bookFile()
    const chapters = chaptersOf(file)

    const index = readIndex(ctx.dataDir, file)
    const previous = index - 2
    if (previous < 0) throw new Error('已经是第一章了，没有上一章')

    saveIndex(ctx.dataDir, file, previous + 1)
    return show(chapters[previous]!, previous + 1, chapters.length)
  },
})
