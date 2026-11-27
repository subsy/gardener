# Changelog

## [0.4.0](https://github.com/subsy/gardener/compare/v0.3.0...v0.4.0) (2026-11-27)


### Features

* read the origin model from named regexes with originModels, the model named first on the attribution line ([5f36fdc](https://github.com/subsy/gardener/commit/5f36fdc6c6048b6fc4d85f542cd1d67729721657))
* trace each fix to the merged PRs whose fresh lines it rewrote, and report it per model ([69e6d66](https://github.com/subsy/gardener/commit/69e6d6691afec99d582a0b96c16c3c54b675b922))
* trace each fix to the PRs whose fresh code it repaired, and total them per model ([c8674df](https://github.com/subsy/gardener/commit/c8674dfa981bcb57a5e3e26f8e7ed365c7bcf6fb))


### Bug Fixes

* count only PRs fetched with a description as merged per model, check originModelPattern only when it is used, and say origins are window-only ([fd179a0](https://github.com/subsy/gardener/commit/fd179a00b1df180dd04bd4935a6ea85345ef241a))

## [0.3.0](https://github.com/subsy/gardener/compare/v0.2.0...v0.3.0) (2026-11-25)


### Features

* count fix PRs that were backlog work apart from new fixes ([b0bdd34](https://github.com/subsy/gardener/commit/b0bdd3428dd9993004ff656f1abda5be5b33bc8c))
* count fix PRs that were backlog work apart from new fixes ([c4351ef](https://github.com/subsy/gardener/commit/c4351ef6826bff986761a2a55608a14ebdb2b90c))


### Bug Fixes

* count backlog fixes by matching each backlog PR's merge commit to the measured commits ([1700508](https://github.com/subsy/gardener/commit/1700508f4a12b0696bca8728289156810d51e52d))
* count only backlog fix PRs merged into the measured branch, and hide the split when unconfigured ([622de4d](https://github.com/subsy/gardener/commit/622de4d3e451793b77d131106731b73095df25b3))

## [0.2.0](https://github.com/subsy/gardener/compare/v0.1.2...v0.2.0) (2026-11-16)


### Features

* show whether agent corrections turn into checks: your own weeds, reverts, comments, rules and verification ([#1](https://github.com/subsy/gardener/issues/1)) ([9fc2fdf](https://github.com/subsy/gardener/commit/9fc2fdfb76e2b6118c971208a902363e0c303cf7))
