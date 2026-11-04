import { PageSource } from './page'

export class OfficePage {
  /** The Document Server editor page for one document: `[key, html]`, which the isolate's `office.writePage` writes. */
  static page(setup: { api: string; config: unknown }, theme: 'light' | 'dark'): [string, string] {
    const config = structuredClone(setup.config) as { document?: { key?: string; title?: string }; editorConfig?: { customization?: Record<string, unknown> } }
    if (config.editorConfig?.customization) config.editorConfig.customization['uiTheme'] = theme === 'dark' ? 'theme-night' : 'theme-white'
    const key = String(config.document?.key ?? 'document').replace(/[^\w.-]/g, '_')
    const json = JSON.stringify(config).replace(/</g, '\\u003c')
    const title = PageSource.escape(String(config.document?.title ?? '文稿'))
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body,#editor{margin:0;height:100%;overflow:hidden}</style>
<script src="${setup.api.replace(/"/g, '&quot;')}"></script></head>
<body><div id="editor"></div>
<script>
if (window.DocsAPI) new DocsAPI.DocEditor('editor', ${json});
else document.body.textContent = 'Document Server 的编辑器脚本没有加载 (${setup.api.replace(/['\\<]/g, '')})';
</script></body></html>
`
    return [key, html]
  }
}
