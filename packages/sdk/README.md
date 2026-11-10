# @floppy/sdk

Ce qu'il faut pour écrire un plugin Floppy. *What you need to write a Floppy plugin.*

| Chemin | Contenu |
|---|---|
| `floppy-plugin.d.ts` | Les types d'un plugin (source unique : copiés dans chaque plugin et dans le kit des plugins personnels). |
| `template/` | Le gabarit de `floppy plugin new <id>`. |
| `examples/timer` | Un outil, un réglage, une annonce plus tard. |
| `examples/weather` | Un accès réseau déclaré (`permissions.net`), un fichier `.ts` importé. |
| `wiki/` | Le wiki des plugins (en anglais), servi à l'assistant IA par l'outil `plugin_docs` : règles, recettes, services. Une page = `# titre`, `> résumé`, puis le texte. |

Guide : [docs/guide/plugins/README.md](../../docs/guide/plugins/README.md) · [English](../../docs/guide/plugins/README.en.md).
Spec : [docs/spec/plugins-tiers.md](../../docs/spec/plugins-tiers.md).

`test/types.test.ts` vérifie que ces types suivent ceux du noyau (`npm run typecheck`).
