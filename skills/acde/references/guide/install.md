# Local install

`acde dev` hands your app to the runtime only temporarily. To keep the app in the Dopame desktop on this machine:

```sh
acde install
```

This runs `acde build`, then installs the package into `$XDG_DATA_HOME/acde/packages/<id>` (by default `~/.local/share/acde/packages/<id>`, on Windows `%USERPROFILE%\.local\share\acde\packages\<id>`). It copies to a temporary directory first and then swaps the whole directory in, so you never end up with half a package. A handwritten package (no config, with its own `acde` manifest in `package.json`) is installed as a symlink to the project.

Once installed, the next session you start (and `acde dev --desktop dopame`) will see it.

## Package lookup

In this order; for a given id, the first one found wins:

1. Directories in `ACDE_PATH` (this is how `acde dev` hands over its builds);
2. `$XDG_DATA_HOME/acde/packages/*`;
3. `$XDG_DATA_DIRS/acde/packages/*` (system-wide installs).

## Uninstall

Delete `$XDG_DATA_HOME/acde/packages/<id>`.

## Publishing

An app store and `acde publish` are still in the works. For now, distributing an app means distributing the built package directory (`.acde/`); put it in any of the locations above.
