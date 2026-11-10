# Assets and icons

## public/

The project's `public/` directory (rename it with the `public` config field) is copied as is into the app's `web/`.

References in your pages that start with `/` and point to a file in public:

- In HTML: bundled as usual.
- `url(/x)` in CSS: kept as is in the project's own HTML-entry app (the runtime also serves the app directory at `/`).
- If the file can't be found anywhere, the build fails and tells you which URL in which file, and what's missing from public.

## URLs

App pages have the origin `http://acde.local`. An app's files are served both under `/app/<id>/` and at `/`, so `/logo.png` and relative paths both work.

## Icons

Set `icon` to an icon name or to an image in the project:

```jsonc
{ "icon": "chart" }        // icon name
{ "icon": "assets/logo.svg" } // image in the project
```

**Icon names** refer to Dopame's built-in icon set, which matches the desktop's visual style:

`files` `browser` `editor` `office` `term` `projects` `dash` `team` `dopa` `settings` `store` `app` `timer` `cards` `list` `chart` `calc` `music` `video` `photo` `paint` `game` `chat` `mail` `calendar` `code` `book` `map` `weather`

If omitted, it's `app`.

**Images**: a value that contains `/` or `\`, or has an extension, is treated as a path relative to the project directory, and must be a `.svg` or `.png`. At build time it's copied to the app's `web/icon.<ext>`, and the manifest gets `/app/<id>/icon.<ext>`. `acde check` warns about any other value.
