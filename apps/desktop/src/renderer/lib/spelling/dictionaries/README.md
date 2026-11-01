# English spelling dictionaries

Unmodified data from [overleaf/dictionaries v0.0.3](https://github.com/overleaf/dictionaries/tree/v0.0.3/dictionaries), matching the base dictionary version used in Overleaf's web package. No Overleaf application code or scientific supplement is included.

| File | Upstream Git blob SHA-1 |
| --- | --- |
| en_US.aff | c9d21b5c67f2bd903e8a289ca3da1660a6326de7 |
| en_US.dic | 195e2c3bb64d2e6c10e69ec83677aa3a34154d5b |
| en_GB.aff | 1a03f72501908e8a4e2e755f5a9a24d3abb45f95 |
| en_GB.dic | 7c127fa808cca7d3f1a4402fc79160c30bdf76a9 |

Verify with `git hash-object` before replacing these files. Replace an aff/dic pair together and retain its upstream notices. Vite emits these source-form text files as separate assets without inlining them, so the worker can load them offline under the desktop content policy.

The US data retains SCOWL's permissive component terms. The UK affix header and upstream README identify LGPL licensing; the maintainer supplies LGPL v3. Its file-specific license must not be inferred from the generic Debian package en/* entry. The complete, unmodified dictionary source is distributed with the application. License texts and original notices ship in `apps/desktop/public/licenses/spelling-*`; the root AGPL license does not replace third-party terms.

Base dictionary source: https://github.com/overleaf/dictionaries/tree/v0.0.3

US notices: https://github.com/overleaf/dictionaries/blob/v0.0.3/dictionaries/hunspell-en-us.copyright.txt

UK notices: https://github.com/LibreOffice/dictionaries/blob/master/en/README_en_GB.txt

UK license: https://github.com/marcoagpinto/aoo-mozilla-en-dict/blob/master/LICENSE
