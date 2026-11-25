# Licensing

| Directory | License |
| --- | --- |
| `cli/` | MIT |
| `spaces/` | MIT |
| `spaces/extension/` | GPL-3.0-or-later |
| `browser/` | GPL-3.0-or-later |
| `plugins/omarchy/` | MIT |

Each directory keeps its own `LICENSE` file, and those files govern that directory. `spaces/extension/` is
GPL-3.0-or-later because it bundles the eSpeak NG phonemizer (GPL-3.0); its fonts and other libraries keep their own
licenses next to each file. The Polycarp app carries it as a separate work in `Contents/Resources/extension`. The root has no
license of its own in this step.

`browser/` is GPL-3.0-or-later. It changes Helium (GPL-3.0, imputnet) on the person's own machine; this repo hosts no Helium
binary, Helium's name is not used as a brand, and its logo and non-free assets are not used. `cli/` runs what is in `browser/` as a
separate program and neither links nor embeds its code.

The agent browser extension, AGPL-3.0, with its credits to 0xSero's sitegeist and Mario Zechner's Sitegeist, was removed
from this repo; its code stays in the git history under that license.

`spaces/` also carries third-party license texts in `spaces/LICENSES/`.

`brand/` holds the Polycarp name and logo. The licenses above do not cover them. Newsreader, used for the wordmark, is under the SIL Open Font License.
