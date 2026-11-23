import type { McpServer } from '@modelcontextprotocol/server'
import { resolve } from 'node:path'
import * as z from 'zod'
import { Approvals } from '../approvals.ts'
import { Format } from '../driver/format.ts'
import type { PageToolsHost } from '../mcppage.ts'

const NAMING = 'name one with prompt, or with app and capability'
const LOOK = { readOnlyHint: true, openWorldHint: false }
const DRIVE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export function registerAnswers(server: McpServer, host: PageToolsHost): void {
  server.registerTool(
    'permissions',
    {
      description: 'The approval prompts that wait (id, app, capability, why it is asked) and the decisions made '
        + '(app, capability, granted or denied). Only the camera and the microphone ask; a page that waits for '
        + 'an answer waits in getUserMedia.',
      inputSchema: z.object({}),
      annotations: LOOK,
    },
    () => host.safe(async () => host.text(Format.permissions(await (await host.acde()).permissions()))),
  )

  server.registerTool(
    'answer',
    {
      description: 'Allow or deny an approval prompt that waits. To allow, name the app and the capability, so '
        + 'that what is granted is stated in the call. To deny: the prompt id, or app and capability, or, with '
        + 'neither, the only one waiting (several are listed, not guessed). The decision is kept for the app until '
        + 'revoke takes it back. It stands in for the user\'s own answer: allow only what the user asked for or '
        + 'agreed to, and tell them what you allowed.',
      inputSchema: z.object({
        allow: z.boolean().describe('true grants the capability, false denies it'),
        prompt: z.number().int().positive().optional().describe('the id permissions shows'),
        app: z.string().optional().describe('the app id, together with capability'),
        capability: z.string().optional().describe('the capability asked for (camera or microphone), together '
          + 'with app'),
      }),
      annotations: { ...DRIVE, destructiveHint: true },
    },
    (args) =>
      host.safe(async () => {
        if (args.prompt !== undefined && (args.app !== undefined || args.capability !== undefined))
          throw new Error('answer: give prompt, or app and capability, not both')
        if (args.allow && (args.app === undefined || args.capability === undefined))
          throw new Error('answer: to allow, name the app and the capability (permissions lists what waits)')
        const wanted = {
          ...(args.prompt !== undefined && { prompt: args.prompt }),
          ...(args.app !== undefined && { app: args.app }),
          ...(args.capability !== undefined && { capability: args.capability }),
        }
        return host.text(await Approvals.answer(await host.acde(), wanted, args.allow, NAMING))
      }),
  )

  server.registerTool(
    'revoke',
    {
      description: 'Take back a decision about an app and a capability (as permissions lists them), so the app is '
        + 'asked again the next time it needs it.',
      inputSchema: z.object({
        app: z.string().describe('the app id'),
        capability: z.string().describe('the capability the decision is about'),
      }),
      annotations: { ...DRIVE, destructiveHint: true },
    },
    (args) =>
      host.safe(async () => host.text(await Approvals.revoke(await host.acde(), args.app, args.capability))),
  )

  server.registerTool(
    'choose_folder',
    {
      description: 'Answer the next folder chooser a page opens (showDirectoryPicker) without showing it: a folder, '
        + 'or cancel. Without a host window (headless) a chooser fails unless answered first.',
      inputSchema: z.object({
        path: z.string().optional().describe('the folder, relative to the working directory'),
        cancel: z.boolean().optional().describe('answer as if the user cancelled'),
      }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        if ((args.path === undefined) === (args.cancel !== true))
          throw new Error('choose_folder: give a path, or cancel: true')
        const folder = args.cancel ? null : resolve(host.cwd, args.path!)
        await (await host.acde()).chooseFolder(folder)
        return host.text(folder === null
          ? 'the next folder chooser will be cancelled'
          : `the next folder chooser will answer ${folder}`)
      }),
  )

  server.registerTool(
    'choose_files',
    {
      description: 'Answer the next file chooser a page opens (showOpenFilePicker, <input type=file>) without '
        + 'showing it: one or more files, or cancel. Without a host window (headless) a chooser fails unless '
        + 'answered first.',
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).optional().describe('the files, relative to the working directory'),
        cancel: z.boolean().optional().describe('answer as if the user cancelled'),
      }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        if ((args.paths === undefined) === (args.cancel !== true))
          throw new Error('choose_files: give paths, or cancel: true')
        const files = args.cancel ? null : args.paths!.map((path) => resolve(host.cwd, path))
        await (await host.acde()).chooseFiles(files)
        return host.text(files === null
          ? 'the next file chooser will be cancelled'
          : `the next file chooser will answer ${files.join(', ')}`)
      }),
  )

  server.registerTool(
    'choose_save_file',
    {
      description: 'Answer the next save chooser a page opens (showSaveFilePicker) without showing it: the file to '
        + 'save to, or cancel. Without a host window (headless) a chooser fails unless answered first.',
      inputSchema: z.object({
        path: z.string().optional().describe('the file, relative to the working directory'),
        cancel: z.boolean().optional().describe('answer as if the user cancelled'),
      }),
      annotations: DRIVE,
    },
    (args) =>
      host.safe(async () => {
        if ((args.path === undefined) === (args.cancel !== true))
          throw new Error('choose_save_file: give a path, or cancel: true')
        const file = args.cancel ? null : resolve(host.cwd, args.path!)
        await (await host.acde()).chooseSaveFile(file)
        return host.text(file === null
          ? 'the next save chooser will be cancelled'
          : `the next save chooser will answer ${file}`)
      }),
  )

}
