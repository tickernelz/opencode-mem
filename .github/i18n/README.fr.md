# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)
[![Website](https://img.shields.io/badge/website-opencode--mem.zhafron.my.id-blue)](https://opencode-mem.zhafron.my.id)
[![Docs](https://img.shields.io/badge/docs-opencode--mem.zhafron.my.id%2Fdocs-blue)](https://opencode-mem.zhafron.my.id/docs/)

![OpenCode Memory Banner](../pics/banner.png)

Langues : [🇬🇧](../../README.md) | [🇩🇪](./README.de.md) | [🇨🇳](./README.zh.md) | [🇸🇦](./README.ar.md) | [🇹🇷](./README.tr.md) | [🇳🇱](./README.nl.md) | **🇫🇷**

Un système de mémoire persistante pour les agents de codage IA, qui permet de conserver le contexte à long terme entre les sessions grâce à une base de données vectorielle locale.

## Fonctionnalités principales

- **Base de données locale :** Turso/libSQL embarqué avec recherche vectorielle native, stocké sous `storagePath`. Pas de base vectorielle séparée.
- **Extraction intelligente de mémoires à partir des prompts (auto-capture) :** quand une session devient inactive, une requête IA en arrière-plan transforme le travail technique en mémoires de projet persistantes.
- **Rappel automatique :** les mémoires pertinentes et le profil utilisateur sont injectés dans le contexte du modèle (`chatMessage`).
- **Apprentissage du profil utilisateur :** un résumé trans-projets de vos préférences, schémas et flux de travail.
- **Hygiène des mémoires :** déduplication intelligente, mise à jour à la capture optionnelle et consolidation « dreaming » optionnelle avec corbeille récupérable.
- **Support IA multi-fournisseurs :** tout fournisseur configuré dans OpenCode (`opencodeProvider` / `opencodeModel`), ou une API manuelle : OpenAI Chat Completions, OpenAI Responses, Anthropic, MiniMax, OrcaRouter, Atlas Cloud, Cheaper Inference, API Route, Runcrate, CloudGPU.
- **Embeddings :** plus de 12 modèles d'embedding locaux sur CPU (pas besoin de GPU) ou toute API d'embeddings compatible OpenAI.
- **Interface web complète :** chronologie unifiée mémoires–prompts, profil utilisateur, bibliothèque de skills, coffre Markdown et statistiques de santé, avec authentification HTTP Basic optionnelle.
- **Confidentialité :** balises `<private>`, masquage des identifiants avant capture et chiffrement au repos optionnel.
- **Portabilité :** backend coffre Markdown optionnel, et modes `export` / `import` / `migrate` de l'outil `memory` pour les projets déplacés ou copiés.

## Masquage des identifiants dans les mémoires

Avant que l'auto-capture n'envoie le contexte à son fournisseur de résumé configuré (y compris le repli), le plugin retire les identifiants reconnaissables du texte utilisateur, du texte de l'assistant, des entrées d'outils, des preuves de résultats d'outils conservées et du contexte de mémoires antérieures. Les prompts/preuves en attente sont assainis avant persistance ; les résumés et tags générés sont assainis à nouveau avant l'embedding et l'écriture de nouvelles mémoires. L'outil `add` explicite de `memory` utilise la même frontière d'écriture. Cela s'applique aux mémoires Turso comme aux mémoires Markdown créées par le plugin, sans appel de modèle ni dépendance supplémentaire.

Les formats reconnus incluent les jetons GitHub pris en charge, les formes de clés API OpenAI/Anthropic/OpenRouter/Google, les jetons Slack, les identifiants de clé d'accès AWS, les identifiants « bearer » et les clés privées PEM, ainsi que les affectations d'identifiants détectées prudemment. Les remplacements conservent le contexte utile alentour. La protection `<private>...</private>` existante demeure : les régions imbriquées ou non fermées échouent en mode fermé. Un début de clé privée PEM non fermé masque de même jusqu'à la fin du texte. L'assainissement précède les limites de longueur de capture, afin qu'une troncature ne laisse pas derrière elle une partie d'un identifiant reconnu. Les chaînes de diagnostic du plugin utilisent le même assainisseur ; les correspondances ne sont jamais signalées séparément.

**Limites :** il s'agit d'une protection au mieux pour les copies de mémoires du plugin, pas pour la conversation originale d'OpenCode, les requêtes du modèle principal ou le trafic des outils. Les mots de passe arbitraires, les valeurs « bearer » composées uniquement de lettres, les jetons personnalisés/encodés, les valeurs obscurcies et les identifiants répartis sur plusieurs messages peuvent ne pas être reconnus. Utilisez `<private>` pour les autres textes sensibles. Les hachages, UUID et longues chaînes arbitraires ne sont pas traités comme des secrets. Les mémoires déjà stockées ne sont ni analysées ni réécrites. Les ajouts via le web/l'API, les imports, la réconciliation du Markdown édité par l'utilisateur, les migrations et la génération du profil/dreaming empruntent des chemins distincts et ne sont pas couverts par cette garantie capture/ajout. Les modifications de contenu et de tags via le client mémoire partagé sont assainies lorsqu'elles sont fournies, mais les champs historiques non touchés sont préservés (et peuvent encore être ré-embeddés par le comportement d'édition existant). Le contenu nouvellement capturé/ajouté est déjà masqué lorsqu'il est ensuite recherché, affiché ou injecté ; ce n'est pas un nettoyage à la lecture des données historiques. Gardez les identifiants hors des entrées de mémoire autant que possible, et révoquez tout identifiant déjà divulgué.

## Prérequis

Ce plugin utilise Turso embarqué (`@tursodatabase/database`) avec des vecteurs `F32_BLOB` et une recherche cosinus exacte via `vector_distance_cos`. Aucune base vectorielle séparée ni build SQLite personnalisé n'est requis.

**Runtime recommandé :**

- Bun
- Environnement de plugin OpenCode standard
- Un accès Internet au premier usage si vous utilisez le modèle d'embedding local par défaut, car le modèle est téléchargé par `@huggingface/transformers`.
- Pour les installations depuis les sources/en développement, lancez `bun install` avant de builder ou de tester. Le paquet publié du plugin installe ses dépendances runtime automatiquement via OpenCode.

**Plateformes testées en CI :** Linux, Windows et macOS 15 / macOS 26 sur Apple Silicon (`darwin/arm64`). **Les Mac Intel (`darwin/x64`) ne sont pas pris en charge** — `@tursodatabase/database` et les releases figées d'`onnxruntime-node` ne livrent pas de binding natif x64. Les anciennes versions de macOS ne sont pas exclues par cette matrice ; elles sont simplement hors du jeu actuel de runners hébergés par GitHub.

**Notes :**

- Les embeddings vectoriels sont stockés et recherchés directement dans Turso ; les insertions stockent des vecteurs `F32_BLOB` pour un classement cosinus exact.
- La recherche vectorielle utilise la distance cosinus exacte via `vector_distance_cos` (pas de DiskANN / index approximatif), avec un classement hybride par mots-clés optionnel quand une chaîne de requête est fournie (`@tursodatabase/database` ne livre pas FTS5).
- Les recherches de session utilisent une colonne `session_id` indexée (remplie rétroactivement depuis `metadata.sessionID` au schéma v2).
- L'auto-capture et l'apprentissage du profil utilisateur exigent un fournisseur IA capable de renvoyer une sortie structurée/par appel d'outil. La recherche/ajout/liste de mémoires fonctionnent même sans configuration de fournisseur pour l'auto-capture.

### Besoins matériels / ressources

opencode-mem ne nécessite **pas** de GPU. Les embeddings locaux tournent sur CPU via `@huggingface/transformers` et ONNX (il n'y a pas de backend MLX). Pas besoin de VRAM supplémentaire.

| Charge de travail | Ressources supplémentaires typiques |
| --- | --- |
| **Embeddings locaux** (`Xenova/nomic-embed-text-v1` par défaut) | Environ **0,5–2 Go de RAM** pendant que le modèle est chargé, selon l'identifiant Hugging Face choisi. Le premier usage télécharge le modèle ; le cache disque se trouve sous `{storagePath}/.cache` (par défaut `~/.opencode-mem/data/.cache`) et représente souvent **des centaines de Mo à ~1–2 Go** par modèle. |
| **Embeddings distants** (`embeddingApiUrl` + `embeddingApiKey`) | RAM ML locale négligeable — seulement la surcharge plugin + Turso. |
| **Base de données / plugin** | Turso/libSQL sur disque sous `storagePath`. La taille croît avec le nombre de mémoires stockées, pas avec la mémoire GPU. |

Les limites de plateforme ci-dessus s'appliquent toujours (pas de Mac Intel `darwin/x64` ; utilisez Apple Silicon, Linux, Windows ou un endpoint d'embedding distant). Voir [Choisir / configurer les embeddings](#choisir--configurer-les-embeddings).

### Migration depuis les anciens shards SQLite

Au démarrage, les remplacements re-embed interrompus sont récupérés, les index DiskANN libSQL sont convertis vers le moteur Turso actuel, puis le schéma des anciens shards est vérifié ou mis à niveau. La conversion de moteur s'exécute même quand un store a déjà un marqueur de migration legacy terminé, et préserve les vecteurs stockés sans ré-embedding. Chaque base convertie est sauvegardée sous `<database>.pre-tursodb-<timestamp>.bak`.

Sur macOS et Linux, plusieurs sessions OpenCode peuvent partager le même `storagePath` via le `multiprocess_wal` expérimental de Turso (tous les processus doivent utiliser le même mode — redémarrez toutes les sessions après la mise à niveau). Sur Windows, le moteur rejette ce drapeau, si bien qu'une seule session OpenCode à la fois peut posséder les bases de mémoires.

`tursoMultiprocessWal: false` ouvre plutôt en mode propriétaire unique : les autres processus échouent alors avec `database is locked` au lieu de partager le store. C'est le choix le plus sûr si des outils étrangers au plugin touchent les mêmes fichiers, car un processus SQLite externe _en écriture_ périme l'index WAL de Turso et sa propre écriture suivante est silencieusement perdue. `tursoAutoHeal` (par défaut `true`) déplace les fichiers annexes d'index `-shm`/`-tshm` d'un store vers `storagePath/recovery/<db>-<timestamp>/` et réessaie une fois quand une ouverture échoue avec un index WAL périmé, après avoir vérifié une copie de la base principale. Un `-wal` non vide n'est jamais déplacé, donc les transactions validées mais non checkpointées survivent ; seul un `-wal` absent ou de 0 octet est retiré. Les sessions concurrentes sérialisent la réparation via `storagePath/recovery/<db>.lock`.

Au premier démarrage après une mise à niveau, opencode-mem migre automatiquement les bases de shards de mémoires existantes vers le format vectoriel natif Turso/libSQL :

- Chaque shard est sauvegardé sous `<shard>.db.legacy.bak` avant réécriture
- La progression est suivie par shard dans `<shard>.db.turso-migrate.json`
- Un marqueur global `.turso-migrated` n'est écrit qu'après vérification réussie de tous les shards
- Les insertions et suppressions normales n'invalident pas une migration de shard terminée ; le démarrage vérifie toujours que ses vecteurs sont lisibles et correspondent aux dimensions stockées
- Ne lancez pas plusieurs instances OpenCode sur le même `storagePath` pendant la migration ; un fichier verrou (`.turso-migrate.lock`) empêche toute migration concurrente
- Les migrations manuelles de dimensions utilisent `.turso-operation.lock` ; les autres processus du plugin refusent les nouvelles écritures de mémoires jusqu'à la fin de la migration
- Les verrous expirent après 30 minutes sans mise à jour de l'horodatage de progression (ou de la date de modification du fichier si l'horodatage est indisponible), même si le processus propriétaire est vivant. Ce bail utilise l'heure murale : un saut d'horloge en avant de plus de 30 minutes peut expirer prématurément une opération en cours ; un saut en arrière ou un verrou daté dans le futur peut prolonger la vie d'un verrou inerte. Les verrous portent un identifiant d'acquisition unique, et le nettoyage des verrous périmés ne retire que le fichier exact qu'il a inspecté. Les migrations émettent un heartbeat à mesure qu'elles progressent et s'interrompent si elles découvrent que la propriété a été perdue. Le nettoyage des verrous périmés est journalisé pour diagnostic

Si la migration est interrompue, le prochain démarrage reprend automatiquement depuis la sauvegarde.

Si un shard devient incompatible (par exemple après un changement d'`embeddingDimensions`), les écritures sont bloquées et la base originale reste intacte. Utilisez la migration re-embed de l'interface web pour construire et vérifier un remplacement avant qu'il ne soit mis en place. L'ancien shard reste disponible sous `<shard>.db.pre-reembed-<pid>-<timestamp>.bak`.

## Migrations de schéma

Les shards Turso locaux et les bases auxiliaires (`metadata.db`, `user-prompts.db`, `user-profiles.db`, `ai-sessions.db`) sont mis à niveau avec des migrations `PRAGMA user_version` ordonnées dans `src/services/turso/schema-migrations.ts`. Les migrations sont idempotentes : le démarrage du plugin n'applique que les versions en attente.

## Premiers pas

Pour OpenCode v2, ajoutez le paquet à la liste native `plugins` :

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode charge aussi automatiquement le compagnon `./tui` du paquet pour que les toasts d'auto-capture / de profil / d'erreur s'affichent dans le TUI (les plugins serveur ne peuvent pas appeler `ui.toast` directement). Pas besoin d'une deuxième entrée dans `plugins`. Si vous utilisez un TUI CLI seul face à un serveur OpenCode distant, enregistrez `opencode-mem/tui` dans la liste de plugins de ce CLI (par exemple `cli.json`) pour que le compagnon puisse s'abonner aux événements RPC de toast.

Pour OpenCode v1, ajoutez le point d'entrée par défaut à votre configuration dans `~/.config/opencode/opencode.json` :

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

Avec `@latest` (ou une plage semver) et `autoUpdate: true` dans `opencode-mem.jsonc` (par défaut), le plugin vide l'installation en cache d'OpenCode quand une nouvelle release npm est disponible et vous demande de redémarrer. Les versions épinglées comme `opencode-mem@2.26.0` ne sont jamais mises à jour automatiquement.

### Contexte mémoire automatique sur OpenCode v2

Le plugin v2 fournit le contexte mémoire automatique via le contexte système du modèle. Ces blocs ne sont pas ajoutés au prompt utilisateur rédigé ni stockés dans la transcription du chat. Avec `chatMessage.injectOn: "first"` (par défaut), le contexte initial de la session est conservé entre les tours utilisateur et les étapes du modèle. Avec `"always"`, il est rafraîchi à chaque tour utilisateur rédigé.

Après un redémarrage de l'hôte ou du plugin, une session reprise reconstruit son contexte depuis le store de mémoires actuel à sa prochaine requête au modèle, même si aucun nouveau prompt utilisateur n'arrive. Le contexte reconstruit peut différer de l'original à mesure que les mémoires et le profil évoluent. La restauration ne capture pas de prompt utilisateur synthétique et ne stocke pas de deuxième copie du texte des mémoires dans le stockage de plugins d'OpenCode. La compaction invalide le contexte automatique en cache ; la restauration existante de mémoire de compaction continue aussi de s'exécuter.

### Utiliser un checkout local

Pour exécuter le plugin depuis un checkout local des sources plutôt que la release npm, faites `bun install && bun run build` dans le checkout, puis pointez la liste `plugins` vers le répertoire du checkout :

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Pointez vers la racine du paquet, pas vers `dist/` ni un fichier seul. OpenCode résout un plugin répertoire en se repliant sur `<directory>/index` (OpenCode ne lit pas les `exports`/`main` du `package.json` pour un spec de chemin dans les releases actuelles), donc ce dépôt livre un mince `index.js` racine qui ré-exporte le point d'entrée v2 buildé depuis `dist/plugin.js`, et un `tui.js` racine qui ré-exporte `dist/tui.js` pour le compagnon TUI. Un chemin vers un fichier est rejeté (`configured plugin path must be a directory`), et un répertoire sans `index.js` racine est ignoré silencieusement.

### Chiffrement optionnel de la base au repos

Activez le chiffrement AES-256-GCM des shards Turso locaux dans `~/.config/opencode/opencode-mem.jsonc` :

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

Au premier démarrage, le plugin crée `~/.config/opencode/opencode-mem-db.key` (clé hex de 32 octets, `chmod 600`) et migre les shards en clair existants. Remplacez-la avec `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` ou `"file://~/path/to.key"` si vous gérez la clé vous-même. Perdre la clé signifie que les bases chiffrées ne peuvent plus être ouvertes. `databaseEncryptionCipher` choisit l'algorithme : `aes256gcm` (par défaut), `aes128gcm`, `aegis256`, `aegis256x2`, `aegis128l`, `aegis128x2` ou `aegis128x4`.

**Windows :** utilisez `%USERPROFILE%\.config\opencode\opencode.json` (par exemple `C:\Users\<you>\.config\opencode\opencode.json`). Ce plugin ne lit **pas** `%APPDATA%` ni `%LOCALAPPDATA%` pour son entrée de plugin OpenCode — placez le fichier sous `.config\opencode` dans votre profil utilisateur, puis redémarrez OpenCode. Si le plugin n'apparaît pas, confirmez ce chemin et redémarrez à nouveau.

Le plugin se télécharge automatiquement au prochain démarrage.

## Utilisation au quotidien

Vous n'avez **pas** besoin de demander à OpenCode de « se souvenir » de choses pour que le plugin fonctionne. Avec les réglages par défaut, la mémoire se construit au fil de votre travail.

### Flux quotidien type

1. Activez le plugin (voir [Premiers pas](#premiers-pas)) et redémarrez OpenCode.
2. Configurez un fournisseur IA pour l'auto-capture — recommandé : `opencodeProvider` + `opencodeModel` (ou `"opencodeModel": "inherit"`). Détails dans [Fournisseur IA de l'auto-capture](#fournisseur-ia-de-lauto-capture).
3. Travaillez normalement dans OpenCode. Quand une session devient inactive, l'auto-capture extrait le contexte technique mémorable et le stocke.
4. Dans les sessions suivantes, les mémoires pertinentes sont injectées dans le contexte (voir les réglages `chatMessage` / compaction). Parcourez-les ou modifiez-les dans l'interface web à `http://127.0.0.1:4747`.
5. Utilisez l'outil `memory` quand vous voulez stocker ou récupérer quelque chose immédiatement (voir [Exemples d'utilisation](#exemples-dutilisation)).

### Mémoire automatique ou manuelle

| Approche | Quand elle s'exécute | Ce que vous faites |
| --- | --- | --- |
| **Auto-capture** (`autoCaptureEnabled: true`, par défaut) | Après des tours de conversation, quand la session devient inactive | Rien — l'extraction est automatique |
| **Manuelle** : outil / commandes `memory` | À la demande | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import`, `help` |

La recherche/ajout/liste manuels fonctionnent même si aucun fournisseur n'est configuré pour l'auto-capture. L'auto-capture et l'apprentissage du profil utilisateur exigent un fournisseur capable de renvoyer une sortie structurée/par appel d'outil.

### Mémoire, AGENTS.md ou Skills

| À stocker dans **memory** | À stocker dans **AGENTS.md** / docs statiques | À stocker en **Skills** (interface web / `skills.db`) |
| --- | --- | --- |
| Décisions propres au projet, schémas de bugs, « on a essayé X et ça a échoué » | Règles et flux de travail stables qui changent rarement | Procédures réutilisables que l'agent charge à la demande |
| Préférences utilisateur découvertes au fil des sessions | Conventions de codage et processus toujours actifs | Packs de skills éditables par l'équipe, partagés via le même stockage |
| Faits qui doivent vous suivre d'un chat à l'autre | Instructions que chaque agent doit voir, indépendamment de la recherche | Outil `skill` natif d'OpenCode (pont plugin V2) |

Règle générale : instructions de projet durables et toujours actives → `AGENTS.md` ; contexte de travail croissant → memory ; procédures réutilisables à la demande → **Skills**.

#### Skills partagés (V2)

- Créez/modifiez des skills dans l'explorateur web (onglet **Skills** à `/skill-library`).
- Persistés dans `skills.db` sous le chemin de stockage du plugin (pas comme vecteurs de mémoire).
- Sur OpenCode **V2**, le plugin enregistre les skills activés via `ctx.skill.transform` pour que l'agent puisse les charger avec l'outil natif `skill`.
- Catalogue HTTP optionnel pour d'autres instances OpenCode : `"skills": ["http://127.0.0.1:4747/skills/"]` (sert `/skills/index.json` et `/skills/<id>/<id>.md` — distinct du chemin de l'interface).
- REST : `GET/POST /api/skills`, `GET/PUT/DELETE /api/skills/:id`.

### Statistiques de santé

L'onglet **Stats** de l'interface web (à `/stats`) montre la santé du système de mémoire en un coup d'œil : totaux par portée, comptes de mémoires par shard avec avertissements de shards périmés/manquants et un indicateur de duplication par tags identiques, la version active du profil utilisateur, et une série d'activité sur 14 jours (captures, captures ignorées, injections de profil/compaction et erreurs regroupées par message) analysée depuis les journaux structurés du plugin dans `~/.opencode-mem/`. C'est en lecture seule — `GET /api/stats` — et chaque section se dégrade si une base est indisponible, si bien que le reporting continue pendant les incidents.

### Extraction intelligente de mémoires à partir des prompts

Cette expression de la liste des fonctionnalités désigne l'**auto-capture** : après une conversation, une requête IA en arrière-plan résume le travail technique et le sauvegarde comme mémoire. Aucun prompt spécial de votre part n'est requis. Elle utilise `opencodeProvider` / `opencodeModel` s'ils sont définis, sinon le repli manuel `memoryProvider`.

L'auto-capture utilise des résultats d'outils textuels bornés en plus du texte de l'assistant. Le statut d'invocation n'est pas la preuve qu'une commande, un test ou une tâche a réussi : les résumés doivent distinguer les plans, les tentatives, les échecs, les résultats observés et les affirmations non vérifiées. Les leçons utiles d'échec/de récupération peuvent être mémorisées ; les échecs de commandes routiniers n'ont pas besoin de produire des mémoires.

Les résultats d'outils sont filtrés pour la confidentialité avant troncature, limités à 2 Kio par résultat et 16 Kio pour tout le bloc de preuves d'outils (ou moins sous un petit budget de contexte). Jusqu'à 32 appels sont conservés, en préservant les tentatives anciennes et récentes et en marquant explicitement les omissions. Les pièces jointes, les métadonnées arbitraires et les journaux complets ne sont pas importés. Cela n'ajoute pas de nouveau store de preuves ; les bornes/expirations existantes de récupération de sessions supprimées restent inchangées. Ces extraits sont des preuves partielles, pas un vérificateur, et les résumés du modèle peuvent encore être faux.

Les résumés de capture générés sont limités à 8 Kio UTF-8, avec au plus huit tags de 64 octets. Les réponses surdimensionnées empruntent le chemin de repli/réessai existant plutôt que de tronquer silencieusement une réserve sur le résultat ; les réécritures update-on-capture surdimensionnées se replient sur l'ajout du brouillon borné. Ces limites s'appliquent avant l'embedding/le stockage des mémoires, pas à tout le trafic de réponses du fournisseur. Les fournisseurs externes conservent les requêtes et réponses brutes dans leur historique de session existant (expiration par défaut de sept jours), avant la validation de capture. Les preuves d'outils dans les requêtes sont bornées, mais cela ne borne pas les réponses brutes du fournisseur ; les réessais conservent des copies séparées et le nettoyage doit s'exécuter. Ce n'est pas un plafond global de taille de base, et supprimer des lignes ne réduit pas nécessairement immédiatement les fichiers DB/WAL. Aucune mémoire historique ni aucun réglage d'historique fournisseur n'est modifié.

### Profil utilisateur

Le **profil utilisateur** est un résumé distinct et trans-projets de votre façon de travailler (préférences, habitudes). Il est mis à jour à intervalle (`userProfileAnalysisInterval`, par défaut tous les 10 prompts analysés), affiché dans la vue profil de l'interface web, et lisible via `memory({ mode: "profile" })`. Vous ne le remplissez pas à la main en usage normal — l'apprentissage du profil le remplit quand un fournisseur est prêt. La langue de sortie suit `autoCaptureLanguage` (par défaut `"auto"`, reflétant la langue de vos prompts), le même réglage que pour les mémoires auto-capturées.

**« No profile found. Keep chatting to build your profile. »** est l'état vide attendu, pas un crash. L'apprentissage du profil exige :

1. Une auto-capture en marche avec un fournisseur joignable (`opencodeProvider` + `opencodeModel`, ou un repli manuel complet avec `memoryModel` + `memoryApiUrl`).
2. Assez de prompts de session depuis la dernière analyse — au moins `userProfileAnalysisInterval` (par défaut **10**).
3. Que ce fournisseur supporte la sortie structurée/par appel d'outil (même exigence que l'auto-capture).

Si vous avez discuté un moment et voyez encore ce message, vérifiez que l'auto-capture se déclenche bien dans les journaux et que le fournisseur configuré réussit (une analyse de profil en échec ne se cache plus derrière un état vide générique quand le fournisseur renvoie une erreur).

### Interface web

Ouvrez `http://127.0.0.1:4747` pour parcourir la chronologie mémoires–prompts, inspecter les captures et gérer le profil utilisateur. L'interface a cinq vues : **Mémoires du projet** (`/project-memories`), **Profil utilisateur** (`/user-profile`), **Bibliothèque de skills** (`/skill-library`), **Coffre Markdown** (`/markdown-vault`) et **Stats** (`/stats`). Changez le port avec `webServerPort`, ou mettez `webServerEnabled: false` pour tourner sans interface web. Si vous liez le serveur au-delà du loopback, voir [Authentification Basic HTTP de l'interface web](#authentification-basic-http-de-linterface-web).

La chronologie montre chaque mémoire et chaque prompt une seule fois. Si plusieurs prompts de capture se réfèrent à une même mémoire, son prompt actuel lui est apparié quand il est disponible sur la page ; les prompts antérieurs restent visibles comme entrées séparées.

## Exemples d'utilisation

```typescript
memory({ mode: "add", content: "Le projet utilise une architecture microservices" });
memory({ mode: "search", query: "décisions d'architecture" });
memory({ mode: "search", query: "décisions d'architecture", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
memory({ mode: "export", outputPath: "./memories.json" });
memory({ mode: "import", inputPath: "./memories.json" });
```

Accédez à l'interface web à `http://127.0.0.1:4747` pour parcourir et gérer visuellement les mémoires.

**Sécurité de liaison réseau :** gardez `webServerHost` sur `127.0.0.1` sauf si vous exposez intentionnellement l'interface. Une liaison à `0.0.0.0` (ou tout hôte non loopback) exige `webServerApiToken` ; toutes les requêtes `/api/*` doivent alors envoyer `Authorization: Bearer <token>` ou `X-Opencode-Mem-Token`. Ouvrez l'interface avec `?apiToken=<token>` pour que le navigateur le stocke et l'envoie.

Les migrations de dimensions génèrent d'abord chaque nouvel embedding, les importent dans un shard temporaire indexé, vérifient le nombre de lignes, et ne remplacent qu'ensuite le fichier original. Les migrations en échec laissent le shard source intact.

## Configuration essentielle

Configurez dans `~/.config/opencode/opencode-mem.jsonc` :

**Windows :** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (même répertoire `.config\opencode` que ci-dessus — pas AppData). Le stockage par défaut se résout en `%USERPROFILE%\.opencode-mem\data` (la forme `~` se déploie aussi vers votre home utilisateur sur Windows).

Le plugin crée un gabarit entièrement commenté à ce chemin au premier démarrage. Pour chaque réglage et commentaire, voir [`opencode-mem.example.jsonc`](../../opencode-mem.example.jsonc).

Options de premier niveau couramment ajustées :

| Option | Défaut | Rôle |
| --- | --- | --- |
| `storagePath` | `"~/.opencode-mem/data"` | Où vivent les bases de mémoires. |
| `webServerEnabled` / `webServerPort` / `webServerHost` | `true` / `4747` / `"127.0.0.1"` | Interrupteur du serveur de l'interface web, port et adresse de liaison. |
| `autoCaptureEnabled` | `true` | Résume les sessions inactives en mémoires (nécessite un fournisseur, voir [Fournisseur IA de l'auto-capture](#fournisseur-ia-de-lauto-capture)). |
| `similarityThreshold` / `maxMemories` | `0.6` / `10` | Score de similarité minimal et nombre maximal de résultats pour la recherche de mémoires. |
| `injectProfile` | `true` | Injecte le profil utilisateur (préférences, schémas, flux de travail) dans le contexte IA. |
| `deduplicationEnabled` / `deduplicationSimilarityThreshold` | `true` / `0.9` | Détecte et retire les mémoires en double. |
| `autoCleanupEnabled` / `autoCleanupRetentionDays` | `true` / `30` | Au plus une fois par jour, supprime les prompts plus vieux que la fenêtre de rétention et les mémoires non mises à jour dans cette fenêtre. Les mémoires épinglées sont conservées. |
| `showAutoCaptureToasts` / `showUserProfileToasts` / `showErrorToasts` | `true` | Toasts pour l'auto-capture, les mises à jour du profil et les erreurs. |
| `autoUpdate` | `true` | Vide l'installation en cache d'OpenCode quand une nouvelle release npm est disponible. |

Les limites de contexte du profil sont définies par `userProfileInjectPreferences` (défaut `5`), `userProfileInjectPatterns` (`5`) et `userProfileInjectWorkflows` (`3`). Elles contrôlent le nombre d'éléments injectés dans la conversation LLM, pas le nombre affiché dans l'interface web. Les anciennes options `maxProfileItems`, `userProfileDisplayPreferences`, `userProfileDisplayPatterns` et `userProfileDisplayWorkflows` sont dépréciées et sans effet. Les fichiers de config existants se chargent toujours, mais vous pouvez retirer ces quatre clés.

### Backend coffre Markdown (`memoryBackend`)

Par défaut, les mémoires vivent uniquement dans Turso sous `storagePath`. Vous pouvez optionnellement définir un **dossier Markdown générique** comme source de vérité (fichiers `.md` simples compatibles Obsidian/Raneto — pas une intégration spécifique à Obsidian) :

```jsonc
{
  "memoryBackend": "markdown",
  "markdownPath": "~/Documents/LLM-Wiki",
}
```

Les fichiers de coffre créés par le plugin préservent la provenance de capture (`promptId`, `sessionID` et `captureTimestamp`) pour que la réindexation puisse restaurer ces champs. Les fichiers legacy sans ces champs conservent les métadonnées correspondantes déjà dans l'index. Une provenance déjà absente du fichier et de l'index ne peut pas être récupérée automatiquement.

| Clé | Défaut | Rôle |
| --- | --- | --- |
| `memoryBackend` | `"database"` | `"database"` garde le contenu dans Turso. `"markdown"` utilise tous les fichiers `.md` sous `markdownPath` comme source de vérité. |
| `markdownPath` | — | Requis quand `memoryBackend` vaut `"markdown"`. Chemin absolu ou `~/…` vers le dossier du coffre. Pas de sous-dossier de mémoires séparé — le chemin _est_ le store. |

Quand le mode Markdown est actif :

- Les mémoires créées par le plugin sont écrites en `{id}.md` avec frontmatter YAML + corps.
- Les notes existantes du dossier (tout style de page Markdown) sont importées/indexées ; Turso n'est qu'un index de recherche sémantique reconstructible.
- Les ajouts/modifications/suppressions de fichiers sont surveillés et réindexés ; l'interface web n'affiche une page latérale **Markdown** (statut, liste des fichiers, réindexation) que dans ce mode.
- Passer à Markdown reconstruit l'index depuis le dossier. Les lignes uniquement en base sans fichier correspondant ne sont abandonnées qu'après un scan lisible et complet d'un coffre non vide. Exportez d'abord avec `memory export` si vous devez garder les anciennes mémoires en base.
- La réconciliation ignore la suppression et avertit quand le coffre est absent, illisible, seulement partiellement scanné ou traité, ou ne contient aucun fichier Markdown ; les mémoires indexées existantes sont conservées. Restaurez ou réparez le coffre, puis réindexez. Pour retirer intentionnellement la mémoire indexée du dernier fichier, supprimez explicitement cette mémoire via l'outil ou l'interface web.
- Un coffre sain et non vide permet toujours la suppression définitive de mémoires indexées dont les fichiers sont absents. Exportez ou sauvegardez d'abord : ces garde-fous ne sont pas une sauvegarde et ne peuvent pas détecter une synchronisation incomplète qui ressemble à un coffre sain et non vide.

### Capture et injection des messages de chat (`chatMessage`)

Ces réglages vivent sous la clé `chatMessage` dans `~/.config/opencode/opencode-mem.jsonc` :

| Option | Défaut | Rôle |
| --- | --- | --- |
| `enabled` | `true` | Capture les prompts utilisateur rédigés et injecte le contexte mémoire. |
| `injectOn` | `"first"` | Pour `recall: "recent"`, injecte au premier message utilisateur ou, avec `"always"`, à chaque tour rédigé. Avec `recall: "relevant"` / `"both"`, le contexte se rafraîchit toujours à chaque tour rédigé (issue #460). |
| `recall` | `"relevant"` | Comment les mémoires injectées sont choisies : `"relevant"` embedde le message utilisateur et lance une recherche vectorielle à chaque tour ; `"recent"` garde l'ancienne liste des N plus récentes ; `"both"` préfère les pertinentes puis remplit les emplacements restants avec les récentes. |
| `recallScope` | `"default"` | Portée du rappel automatique : `"default"` suit `memory.defaultScope`, ou force `"project"` / `"all-projects"`. Lors d'une recherche sur tous les projets, les résultats du projet actuel reçoivent un petit bonus de similarité. |
| `similarityThreshold` | (premier niveau) | Plancher optionnel par injection ; sinon utilise le `similarityThreshold` de premier niveau. |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | Combien de mémoires le contexte injecté contient, si les mémoires capturées dans la session actuelle sont exclues, et une coupure d'âge optionnelle en jours. |
| `filterInjectedPrompts` | `true` | Ignore le texte de prompt injecté par l'hôte ou par d'autres plugins OpenCode (rappels système, directives d'orchestration, notifications de tâches en arrière-plan) pour qu'il ne soit jamais stocké comme si l'utilisateur l'avait tapé. |
| `injectionMarkers` | intégrés | Marqueurs supplémentaires identifiant les blocs injectés ; ajoutés à la liste intégrée, jamais en remplacement. |
| `captureChildSessions` | `false` | Capture les prompts des sessions enfants d'orchestrateur (sessions avec un `parentID`, p. ex. les enfants task/subagent d'OpenCode). Leurs messages « utilisateur » sont écrits par l'agent parent, pas par vous, donc par défaut ils ne sont ni stockés, ni auto-capturés, ni utilisés pour l'apprentissage du profil, ni dotés d'un contexte mémoire injecté. |

Les exclusions de session et d'âge s'appliquent avant la limite de mémoires injectées, si bien que les mémoires exclues ne consomment pas d'emplacements qui pourraient contenir des mémoires éligibles. Mettre `chatMessage.maxMemories` à `0` désactive l'injection des mémoires de projet tout en permettant l'injection du profil utilisateur quand elle est activée.

Les tags de mémoires injectées identifient `selection="recent"` ou `selection="semantic"`. Les sélections récentes (y compris le repli et le remplissage récent dans `both`) n'ont pas de score numérique. Les sélections sémantiques portent un `retrieval_score` fini quand il est disponible ; c'est un signal de classement qui peut inclure le bonus de projet actuel, pas une probabilité de pertinence ou d'exactitude factuelle. Les scores absents ou invalides sont omis. Cela remplace l'ancien attribut de prompt `relevance="...%"` sans changer la sélection, l'ordre, le contenu ou la provenance des mémoires. La compaction conserve son format existant.

Quand le rappel sémantique échoue (par exemple, embedding indisponible), `relevant` et `both` se replient sur la liste récente existante avec les mêmes restrictions de portée, nombre, session et âge. Une recherche réussie sans correspondance éligible reste vide en `relevant` ; `both` se remplit toujours depuis les récentes comme d'habitude. Les avertissements de shard partiel ne déclenchent pas le repli d'échec. Si le repli récent échoue aussi, le rappel reste vide et non fatal. Le repli de requête absente et le comportement de rafraîchissement par tour sont inchangés.

### Mise à jour à la capture (optionnel)

Chemin opt-in qui garde les mémoires à jour quand les faits changent. Quand `updateOnCaptureEnabled` vaut `true`, l'auto-capture embedde le nouveau résumé, cherche des mémoires similaires au-dessus d'`updateOnCaptureSimilarityThreshold` (défaut `0.75`), et demande au modèle de capture de choisir `add`, `update` (réécriture sur place) ou `supersede` (sauvegarde de la nouvelle + suppression douce de l'ancienne en corbeille). Les mémoires épinglées sont ignorées. Désactivé par défaut pour que les installations existantes gardent le comportement ajout-seul.

```jsonc
"updateOnCaptureEnabled": true,
"updateOnCaptureSimilarityThreshold": 0.75,
"updateOnCaptureMaxCandidates": 5,
```

Astuce : avec `Xenova/nomic-embed-text-v1`, activer `embeddingUseTaskPrefixes: true` (et optionnellement abaisser le `similarityThreshold` du rappel) améliore souvent la qualité des correspondances pour les mémoires longues. Les préfixes restent opt-in par défaut.

### Dreaming (consolidation optionnelle des mémoires)

Passe d'arrière-plan opt-in qui trouve les mémoires **liées** (via `dreaming.relatedThreshold`, défaut `0.75`, indépendant d'`deduplicationSimilarityThreshold`), demande à l'`opencodeProvider` / `opencodeModel` configuré (avec `memoryModel` / `memoryApiUrl` en repli, même ordre de canaux que l'auto-capture) de `merge`, `update`, `supersede`, `keep` ou `flag` les contradictions, et supprime doucement les lignes remplacées vers une corbeille récupérable. Les mémoires épinglées ne sont jamais touchées. Mettez `dreaming.crossProject: true` (ou `memory.defaultScope: "all-projects"`) pour grouper au-delà des tags de projet ; la portée utilisateur reste séparée. Configurez sous `dreaming` dans `opencode-mem.jsonc`. `dreaming.enabled` (défaut `false`) ne contrôle que l'exécution planifiée en arrière-plan — le bouton **Dream** de l'interface web et `POST /api/dreaming/run` fonctionnent toujours quand il est false (mode manuel seul). Les lignes supprimées doucement sont purgées définitivement après `dreaming.trashRetentionDays` lors du nettoyage normal. L'interface web expose aussi la **Corbeille** (restauration).

### Choisir / configurer les embeddings

Les embeddings alimentent la recherche de similarité des mémoires et du profil utilisateur. Configurez-les dans le même fichier (`~/.config/opencode/opencode-mem.jsonc`). Il n'y a **pas de backend MLX** — les embeddings locaux utilisent `@huggingface/transformers` avec ONNX, pas Apple MLX.

**Local (défaut) :** ne définissez qu'`embeddingModel`. Au premier usage, le modèle est téléchargé depuis Hugging Face et mis en cache sous `{storagePath}/.cache` (défaut `~/.opencode-mem/data/.cache`). Les poids restent résidents pendant toute la vie du processus hôte ; définissez `embeddingIdleTimeoutMs` pour les libérer après ce nombre de millisecondes d'inactivité, et la prochaine opération de mémoire les réchauffe depuis le cache local (environ une seconde, pas un re-téléchargement).

**Distant (compatible OpenAI) :** définissez à la fois `embeddingApiUrl` et `embeddingApiKey`. Le plugin appelle alors `{embeddingApiUrl}/embeddings` avec un jeton Bearer. `embeddingApiKey` accepte les mêmes formats de secret que `memoryApiKey` (`literal`, `env://…`, `file://…`).

| Clé | Rôle |
| --- | --- |
| `embeddingModel` | Identifiant Hugging Face (local) ou nom de modèle API (distant). Défaut : `Xenova/nomic-embed-text-v1` |
| `embeddingDimensions` | Remplacement optionnel ; omettez-le en général — les dimensions sont lues depuis une carte intégrée |
| `embeddingPooling` | Pooling local : `"mean"` (défaut), `"cls"` ou `"last_token"`. Non défini → petit préréglage de modèle connu ou `"mean"` |
| `embeddingQueryPrefix` | Préfixe pour les embeddings de tâche de requête. Non défini → préréglage du modèle ou Nomic quand `embeddingUseTaskPrefixes` est true. Un `""` explicite désactive |
| `embeddingDocumentPrefix` | Préfixe pour les embeddings de tâche de document (mêmes règles de résolution qu'`embeddingQueryPrefix`) |
| `embeddingUseTaskPrefixes` | Préfixes Nomic `search_query:` / `search_document:` opt-in quand les préfixes personnalisés/préréglés ne sont pas définis. Défaut `false` |
| `embeddingDtype` | Remplacement optionnel du dtype ONNX local (p. ex. `"q8"`, `"fp32"`). Une fois défini, passé à `pipeline({ dtype })` de transformers.js |
| `embeddingIdleTimeoutMs` | Libère le modèle local après ce nombre de millisecondes d'inactivité (p. ex. `600000` pour 10 minutes). `0` (défaut) le garde chargé pendant toute la vie du processus |
| `embeddingApiUrl` | URL de base d'une API d'embeddings compatible OpenAI (pas de chemin au-delà de `/v1`) |
| `embeddingApiKey` | Clé API pour cet endpoint (requise avec `embeddingApiUrl`) |

Modèles locaux recommandés :

| Modèle | Dims | Notes |
| --- | --- | --- |
| `Xenova/nomic-embed-text-v1` | 768 | Défaut ; multilingue, contexte 8192 ; pooling mean |
| `Xenova/jina-embeddings-v2-base-en` | 768 | Anglais uniquement, contexte 8192 |
| `Xenova/jina-embeddings-v2-small-en` | 512 | Plus rapide, contexte 8192 |
| `Xenova/all-MiniLM-L6-v2` | 384 | Très rapide, contexte 512 |
| `Xenova/all-mpnet-base-v2` | 768 | Bonne qualité, contexte 512 |
| `Xenova/bge-m3` | 1024 | Multilingue ; pooling CLS automatique |
| `intfloat/multilingual-e5-large` | 1024 | Préfixes `query:` / `passage:` automatiques |

Exemple — embeddings OpenAI distants :

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Exemple — bge-m3 local (le pooling vaut CLS par défaut via le préréglage ; remplacez si besoin) :

```jsonc
{
  "embeddingModel": "Xenova/bge-m3",
  // "embeddingPooling": "cls",
  // "embeddingDtype": "q8",
}
```

Changer `embeddingModel`, les dimensions, le pooling ou les préfixes de tâche peut exiger de ré-embedder les mémoires stockées pour que les vecteurs de stockage et de requête restent alignés. Choisissez de préférence un modèle (et des réglages de pooling/préfixes) une fois pour toutes et gardez-les pour un répertoire de données donné.

**Non pris en charge — Mac Intel (`darwin/x64`) :** la persistance locale exige `@tursodatabase/database`, qui ne publie pas de binding natif Mac Intel. Les releases figées d'`onnxruntime-node` (`1.24.1+`, y compris la `1.31.1` épinglée) manquent aussi de darwin/x64. Utilisez un Mac Apple Silicon, Linux ou Windows, ou un endpoint distant via `embeddingApiUrl` + `embeddingApiKey` (exemple ci-dessus). Sur les plateformes prises en charge, `opencode-mem` épingle `onnxruntime-node@1.31.1` (correctif de démontage Ort::Env depuis `1.24.1` / #225) et charge transformers via un shim de résolution CJS pour que les installations imbriquées d'OpenCode gardent ce binding. Transformers est résolu en chemin absolu avant l'installation de ce shim pour que l'hôte Bun `--compile` d'OpenCode n'échoue pas avec `Cannot find module '@huggingface/transformers' from ''`. Après une mise à niveau, videz le cache de plugins imbriqué d'OpenCode (`~/.cache/opencode/packages/opencode-mem@*`) et réinstallez.

### Portée des mémoires

- `scope: "project"` : n'interroge que le projet actuel. C'est le défaut.
- `scope: "all-projects"` : interroge `search` / `list` sur tous les shards de projet.
- `memory.defaultScope` définit la portée de requête par défaut quand aucune portée explicite n'est fournie.

### Authentification Basic HTTP de l'interface web

Quand `webServerHost` vaut autre chose que loopback (par exemple `0.0.0.0`), l'interface web est joignable par n'importe qui sur le réseau. Pour garder vos mémoires hors du LAN, protégez le serveur web avec une authentification HTTP Basic via le même fichier de config que pour tout le reste :

```jsonc
{
  "webServerHost": "0.0.0.0", // optionnel : joindre l'interface depuis le LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optionnel, par défaut l'utilisateur OS actuel
}
```

| Champ | Défaut | Effet |
| --- | --- | --- |
| `webServerAuthPassword` | _(vide)_ | Une fois défini, le serveur exige des identifiants HTTP Basic à chaque requête. Laissez vide pour garder le comportement ouvert par défaut. |
| `webServerAuthUsername` | utilisateur OS (`$USER`) | Nom d'utilisateur exigé par le défi Basic Auth. |

`webServerAuthPassword` accepte les mêmes formats de secret que `memoryApiKey` :

- une chaîne littérale (simple, convient aux machines personnelles),
- `env://SOME_ENV_VAR` pour tirer la valeur de l'environnement au démarrage,
- `file:///path/to/secret` pour la lire depuis un fichier (`chmod 600` recommandé — le plugin avertit si le fichier est lisible par tous).

Le navigateur affiche sa boîte de dialogue Basic Auth native et mémorise les identifiants pour la session en cours ; fermer toutes les fenêtres du navigateur les oublie, si bien que rouvrir le navigateur exige de se reconnecter. Les identifiants sont comparés avec une vérification à temps constant, et la réponse 401 non authentifiée porte `Cache-Control: no-store` pour qu'aucun cache intermédiaire ne la rejoue. CORS est aussi assoupli une fois l'authentification active, pour que d'autres outils du même LAN puissent parler à l'API après authentification.

### Partager une mémoire de projet entre des dépôts imbriqués

Par défaut, un projet est identifié par son dépôt git englobant, si bien que chaque dépôt git physique obtient son propre store de mémoires isolé. C'est incorrect pour les espaces de travail multi-dépôts — arborescences gérées par [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md) de Google, monorepos, ou toute disposition où plusieurs dépôts git imbriqués appartiennent à un seul projet logique — car chaque sous-dépôt serait cloisonné.

Déposez un fichier marqueur **`.opencode-mem-project`** vide à la racine de l'espace de travail :

```
my-workspace/
├── .opencode-mem-project   ← racine de l'espace de travail
├── kernel/                 (dépôt git propre)
├── userspace/              (dépôt git propre)
└── tools/                  (dépôt git propre)
```

Toute session démarrée n'importe où sous le marqueur se résout alors sur cette racine et partage un seul store de mémoires, quel que soit le sous-dépôt où vit le répertoire de travail :

```sh
touch ~/my-workspace/.opencode-mem-project
```

Le marqueur est recherché en remontant depuis le répertoire de travail que chaque chemin de code passe déjà (le répertoire de travail du plugin, le `process.cwd()` de l'API web), si bien que l'identité est **pilotée par le répertoire et indépendante du processus**. Elle ne repose pas sur des variables d'environnement ni une valeur de config globale, qui seraient peu fiables ici : opencode-mem tourne sur plusieurs processus opencode qui partagent un seul serveur web, et seuls certains de ces processus portent une variable d'environnement donnée. Avec le marqueur, la racine du projet est toujours dérivée de l'endroit où la session tourne réellement.

Le marqueur a priorité sur la détection git. Quand il est présent, le remote git propre du sous-dépôt est intentionnellement ignoré (il ne décrirait qu'un seul dépôt imbriqué). Sans marqueur, le comportement est inchangé (identité basée sur git).

### Déplacer ou récupérer des mémoires de projet

opencode-mem indexe les shards de projet par un hachage de l'identité du projet. Déplacer un dépôt (migration d'OS, réorganisation de chemins, passage d'un montage Windows à un chemin natif) peut donc orpheliner l'ancien shard sous `~/.opencode-mem/data/projects/` tandis qu'un nouveau shard vide est créé pour le nouveau chemin.

Ce sont des appels de l'outil `memory` d'OpenCode avec des arguments JSON, pas des commandes à lancer dans un terminal. La notation style issue `memory migrate --from ...` correspond à `memory({ mode: "migrate", fromPath: "..." })`.

**1. Déplacement local quand vous connaissez encore l'ancien chemin**

Ouvrez OpenCode dans le **nouveau** répertoire du projet. Le projet cible ne doit pas déjà contenir de mémoires (la migration s'interrompt sans changement en cas de conflit). Prévisualisez la source, la destination et les actions sur les fichiers détectées avant de changer quoi que ce soit :

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Par sécurité, la migration refuse une source dont le répertoire de projet stocké existe encore. Si vous voulez intentionnellement déplacer une source active, inspectez d'abord la sortie du dry-run puis passez `allowLinkedSource: true`. Les fichiers du shard source original sont conservés comme sauvegardes horodatées `*.pre-path-migrate-*.bak`.

**2. L'ancien chemin a disparu — découvrez d'abord le shard orphelin**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` rapporte chaque hachage de projet, le `projectPath` stocké, le nombre de mémoires et le statut (`current`, `linked`, `orphaned`, `missing-file`, `empty` ou `ambiguous`). `fromHash` est le `scopeHash` hexadécimal minuscule de 16 caractères renvoyé par cet appel. Préférez-le quand l'ancien répertoire n'existe plus ou que plusieurs shards contiennent le même chemin stocké, car les identités basées sur git ne peuvent pas toujours être recalculées depuis un chemin absent.

**3. Sauvegarde / restauration entre machines**

```typescript
// sur la machine source / l'ancien checkout
memory({ mode: "export", outputPath: "./memories.json" });

// sur la machine de destination / le nouveau checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

L'export écrit un document JSON versionné sans vecteurs. L'import remappe les mémoires sur le projet actuel et recalcule les embeddings avec le modèle actuellement configuré. L'import ajoute des mémoires à un projet existant, mais des identifiants de mémoire en double interrompent tout l'import avant écriture ; cela diffère de `migrate`, qui exige une cible vide.

Les fichiers d'export sont en clair et peuvent contenir du contenu de mémoires, des noms/adresses e-mail d'utilisateurs, des URL de dépôts et des chemins de projet absolus. Stockez-les comme d'autres sauvegardes sensibles et supprimez-les quand ils ne sont plus nécessaires. Les entrées entièrement privées sont omises, et les profils utilisateur et l'historique de prompts ne sont pas inclus. Le document contient `schemaVersion: 1` ; les imports rejettent les versions de schéma plus récentes non prises en charge plutôt que de deviner.

### Fournisseur IA de l'auto-capture

L'auto-capture exécute une requête IA en arrière-plan pour résumer le travail technique et le sauvegarder comme mémoire. Elle a besoin de l'une des configurations de fournisseur ci-dessous.

**Recommandé :** utilisez un fournisseur déjà authentifié dans opencode et qui supporte la sortie structurée :

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

Le plugin émet des requêtes à sortie structurée vers l'API de session d'opencode au lieu d'appeler directement les endpoints du fournisseur, si bien qu'opencode possède l'authentification, le rafraîchissement des jetons et le routage des fournisseurs. Le nom du fournisseur doit correspondre à une entrée d'`opencode providers list`, et le modèle choisi doit supporter la sortie JSON structurée via opencode.

Optionnellement, épinglez une variante de raisonnement du modèle avec `"opencodeVariant": "xhigh"` (p. ex. pour grok-4.7). Elle s'applique aux appels LLM internes du plugin (résumés d'auto-capture, apprentissage du profil, nettoyage du profil), y compris quand `opencodeModel` vaut `"inherit"`, pour que le travail d'arrière-plan puisse utiliser un niveau de raisonnement différent de la session interactive.

Les modèles de raisonnement lents (ou les très gros prompts de profil) peuvent dépasser le budget de sortie structurée par défaut de 90 s. Définissez `"opencodeTimeoutMs"` (millisecondes) pour l'étendre pour les appels internes à sortie structurée (résumés d'auto-capture, apprentissage du profil) — p. ex. `"opencodeTimeoutMs": 180000` pour 3 minutes. Les valeurs sont bornées à 10000..600000 ; le défaut reste 90000. Les chaînes numériques sont converties. Le nettoyage du profil utilise un timeout séparé, plus long.

Fournisseurs pris en charge : tout fournisseur listé par `opencode providers list` (p. ex. `anthropic`, `openai`, `github-copilot`, `openrouter`, ...).

Les **modèles gratuits / Zen intégrés** sous l'identifiant de fournisseur `opencode` (p. ex. `big-pickle`) ne peuvent souvent pas exécuter les sessions internes à sortie structurée du plugin — OpenCode peut les rejeter hors du chat interactif. Préférez un fournisseur authentifié d'`opencode providers list`, ou utilisez `"opencodeModel": "inherit"` pour que la capture suive le modèle que vous utilisez déjà dans la session.

Si `autoCaptureEnabled` vaut `true` (défaut) mais que ni `opencodeProvider`/`opencodeModel` ni un repli manuel complet n'est configuré, le plugin journalise un avertissement et affiche un toast au démarrage (quand `showErrorToasts` est activé) pour que la config manquante soit visible sans fouiller les journaux.

Si `opencodeProvider` et `opencodeModel` sont définis, ils ont priorité par défaut sur les réglages manuels `memoryProvider` ci-dessous (`"autoCaptureProviderOrder": "opencode-first"`). Mettez `"autoCaptureProviderOrder": "external-first"` pour préférer l'API manuelle quand les deux sont configurés (utile quand l'API de session de l'hôte est occupée/lente) ; l'autre canal sert de repli. Abaissez `"opencodeTimeoutMs"` pour basculer plus tôt hors du canal opencode.

**Suivre le modèle de la session :** mettez `"opencodeModel": "inherit"` pour utiliser un modèle OpenCode concret au moment de l'appel plutôt qu'un identifiant épinglé. Pour l'**auto-capture**, chaque prompt est enregistré via le hook `chat.params` et la requête de capture réutilise le fournisseur/modèle de ce prompt. Pour l'**apprentissage du profil** et les autres chemins à sortie structurée (qui ne sont pas liés à un seul message utilisateur), `inherit` réutilise d'abord le dernier modèle rapporté par l'hôte sur `chat.params` / le hook de contexte V2, puis se replie sur la liste récente `model.json` d'OpenCode quand elle est présente (en préférant l'`opencodeProvider` configuré). OpenCode v2 n'écrit plus `model.json`, si bien que le modèle de session en processus y est le repli principal. Envoyer l'identifiant de modèle littéral `inherit` n'est jamais valide et causait auparavant `ProviderModelNotFoundError: Model not found: <provider>/inherit` sur ces chemins. `opencodeProvider` reste requis comme porte de config normale.

**Repli :** configuration API manuelle (si vous n'utilisez pas opencodeProvider) :

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**Formats de clé API :**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Modes manuels de `memoryProvider` :

- `openai-chat` : API compatible OpenAI Chat Completions avec appel d'outils/de fonctions. Cela peut fonctionner avec des proxys compatibles comme LiteLLM uniquement quand le modèle amont choisi et le proxy préservent les appels d'outils.
- `openai-responses` : API OpenAI Responses avec sortie par appel de fonction.
- `anthropic` : API Anthropic Messages avec utilisation d'outils.
- `minimax` : endpoint MiniMax compatible Anthropic Messages. Mettez `memoryApiUrl` sur l'endpoint global (`https://api.minimax.io`) ou l'[endpoint Chine](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api.md) (`https://api.minimax.cn`) ; le chemin `/anthropic/v1/messages` et l'en-tête `x-api-key` sont appliqués automatiquement. Utilisez `MiniMax-M3.1-Flash` (recommandé) ou `MiniMax-M3`, tous deux avec un contexte de 1 000 000 de jetons. Flash réfléchit toujours ; mettez optionnellement `memoryExtraParams` à `{ "output_config": { "effort": "max" } }` avec `low`, `medium`, `high`, `xhigh` ou `max` (défaut). Flash rejette la réflexion désactivée et l'effort `none`, et ne supporte pas `service_tier`. La réflexion de M3 est désactivée par défaut sur cet endpoint ; activez-la avec `{ "thinking": { "type": "adaptive" } }`. Les identifiants de modèle restent explicitement configurés ; les identifiants personnalisés ou legacy existants sont transmis inchangés. Voir la [référence de compatibilité MiniMax](https://platform.minimax.io/docs/api-reference/text-anthropic-api.md).
- `orcarouter` : passerelle de modèles compatible OpenAI avec identifiants de modèle à espace de noms. `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://api.orcarouter.ai/v1` et `orcarouter/auto` (un alias de routage qui choisit un modèle capable par requête). Si vous définissez `memoryModel`, utilisez un identifiant à espace de noms comme `openai/gpt-5.5` ou `deepseek/deepseek-v4-flash` ; OrcaRouter rejette les noms de modèle nus. Exemple :
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) fait aussi tourner une sécurité zero-trust au niveau de la passerelle pour les agents IA sur le même endpoint — filtrant chaque prompt/réponse et gouvernant chaque appel d'outil sur une base de refus par défaut, sans changement de code applicatif.
- `atlas-cloud` : préréglage Chat Completions compatible OpenAI pour [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://api.atlascloud.ai/v1` et `deepseek-ai/deepseek-v4-pro`. Si `memoryApiKey` est omis, `ATLASCLOUD_API_KEY` de l'environnement est utilisé. Exemple :
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://api.atlascloud.ai`.
- `cheaper-inference` : préréglage Chat Completions compatible OpenAI pour [Cheaper Inference](https://cheaperinference.com). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://api.cheaperinference.com/v1` et `gpt-5.4-mini`. Si `memoryApiKey` est omis, `CHEAPER_INFERENCE_API_KEY` de l'environnement est utilisé. Exemple :
  ```jsonc
  "memoryProvider": "cheaper-inference",
  "memoryApiKey": "env://CHEAPER_INFERENCE_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://api.cheaperinference.com`.
- `api-route` : préréglage Chat Completions compatible OpenAI pour [API Route](https://www.api-route.com/en/docs/quickstart). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://global.api-route.com/v1` et `gpt-6.1-sol`. Si `memoryApiKey` est omis, `API_ROUTE_API_KEY` de l'environnement est utilisé. Exemple :
  ```jsonc
  "memoryProvider": "api-route",
  "memoryApiKey": "env://API_ROUTE_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://global.api-route.com`.
- `runcrate` : préréglage Chat Completions compatible OpenAI pour [Runcrate](https://www.runcrate.ai). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://api.runcrate.ai/v1` et `deepseek-ai/DeepSeek-V4.1-Flash`. Si `memoryApiKey` est omis, `RUNCRATE_API_KEY` de l'environnement est utilisé. Exemple :
  ```jsonc
  "memoryProvider": "runcrate",
  "memoryApiKey": "env://RUNCRATE_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://api.runcrate.ai`.
- `cloudgpu` : préréglage Chat Completions compatible OpenAI pour [CloudGPU](https://cloudgpu.app). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://cloudgpu.app/v1` et `deepseek-v4.1-flash`. Si `memoryApiKey` est omis, `CLOUDGPU_API_KEY` de l'environnement est utilisé (créez une clé sur https://cloudgpu.app/api/console ; docs API : https://cloudgpu.app/api/docs). Exemple :
  ```jsonc
  "memoryProvider": "cloudgpu",
  "memoryApiKey": "env://CLOUDGPU_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://cloudgpu.app`.
- `standardcompute` : préréglage Chat Completions compatible OpenAI pour [Standard Compute](https://standardcompute.com). `memoryApiUrl` et `memoryModel` sont optionnels — ils valent par défaut `https://api.stdcmpt.com/v1` et `StandardCompute`. Si `memoryApiKey` est omis, `STANDARDCOMPUTE_API_KEY` de l'environnement est utilisé (créez une clé sur https://standardcompute.com/dashboard ; docs API : https://docs.standardcompute.com). Exemple :
  ```jsonc
  "memoryProvider": "standardcompute",
  "memoryApiKey": "env://STANDARDCOMPUTE_API_KEY",
  ```
  Quand ce fournisseur est choisi, les prompts d'auto-capture / de profil, les réponses du modèle et le contexte de conversation pertinent sont transmis à `https://api.stdcmpt.com`.

Dépannage :

- Les échecs d'auto-capture ne bloquent pas l'usage manuel de l'outil `memory`.
- L'auto-capture préserve le texte final borné de l'assistant et les résultats d'outils terminaux des événements V1/V2 livrés avant que le résumé différé ne s'exécute. La capture normale au repos préfère toujours la transcription live de l'hôte ; les preuves en attente prêtes sont le repli quand la session a déjà disparu (suppression ou rejeu au démarrage). La récupération est limitée au même projet et utilise le fournisseur de capture normal et la file de claims. Elle ne déduit pas un travail terminé de la seule requête. Supprimer une session OpenCode ne supprime **pas** ces preuves de mémoire en attente ni les mémoires déjà capturées.
- Les preuves en attente sont masquées des balises privées avant persistance (y compris les balises s'étendant sur plusieurs parties de texte final au sein d'un même message assistant) ; le raisonnement, les pièces jointes, les métadonnées brutes du fournisseur, les deltas de streaming et les arguments d'outils sont exclus. Les limites sont 16 Kio par partie, 16 parties par prompt, 256 parties globalement (au plus 4 Mio de texte) et 64 Kio par capture. La troncature est marquée ; les parties les plus anciennes sont évincées quand le budget est dépassé. Les preuves expirent après 24 heures et sont élaguées lors des accès suivants au store. Elles sont effacées quand la capture se termine/est ignorée ou que son prompt est retiré par les chemins existants de suppression/rétention. Ce sont des limites de rétention logiques, pas un effacement sécurisé des sauvegardes SQLite/WAL.
- Les événements V2 sont un flux volatil : les événements déconnectés/manqués, les associations de prompts non résolvables et les preuves perdues par expiration/éviction ne peuvent pas être récupérés. La garantie est la capture à partir de preuves reçues, sauvegardées et checkpointées prêtes par un événement idle/deleted, pas la reconstruction de transcriptions non vues ou précédemment supprimées. Après ce checkpoint, la session est scellée contre les réassociations tardives jusqu'à la prochaine entrée utilisateur rédigée (`session.inbox.delivered` V2, `message.updated` utilisateur V1), si bien que les parties en tampon ne peuvent pas rebasculer des preuves prêtes en non-prêtes. Une déconnexion avant le checkpoint terminal laisse les preuves partielles différées jusqu'à un checkpoint ultérieur ; le redémarrage ne suppose pas qu'un travail inachevé est terminé. V1 utilise des identifiants parents d'assistant explicites ; V2 fige l'entrée livrée au début de l'étape plutôt que de deviner le dernier prompt en file.
- Si l'hôte live rapporte `Session.NotFoundError` (ou que la suppression/le rejeu au démarrage n'a pas de preuves prêtes), la capture journalise `skipped` / `session_not_found`, libère son claim sans backoff ni consommation de réessais, et ignore les recherches dépendant de l'hôte dans ce lot. Les prompts ultérieurs avec des preuves sauvegardées prêtes avancent toujours. Un idle indépendant ultérieur peut réessayer. Les prompts déjà épuisés ne sont pas ressuscités. Les autres échecs conservent leur comportement de réessai existant.
- Les ajouts d'auto-capture utilisent un identifiant stable par projet/prompt pour que le rejeu séquentiel crash/redémarrage réutilise la mémoire antérieure, y compris les enregistrements supprimés doucement, au lieu de l'insérer ou de la ressusciter. Cela ne revendique pas une sémantique distribuée exactement-une-fois pour les opérations optionnelles de mise à jour/remplacement sémantiques ni pour chaque entrelacement de crash multi-processus.
- Si l'auto-capture rapporte qu'un fournisseur n'est pas connecté, confirmez le nom du fournisseur avec `opencode providers list` et configurez d'abord ce fournisseur dans opencode.
- Si un proxy ou un fournisseur personnalisé renvoie du texte brut au lieu d'une sortie structurée/par outil, choisissez un autre modèle/fournisseur ou utilisez l'un des modes de fournisseur manuels ci-dessus.
- Pour les modèles qui rejettent `temperature`, ajoutez `"memoryTemperature": false` avec la configuration API manuelle.
- Pour les modèles qui rejettent les appels d'outils forcés (`tool_choice: "required"`, p. ex. certains modes de réflexion), ajoutez `"forceToolChoice": false` avec `openai-chat` / `orcarouter` / `atlas-cloud` / `cheaper-inference` / `api-route` / `runcrate` / `cloudgpu` / `standardcompute`.
- Pour `opencodeProvider` / `opencodeModel` (p. ex. DeepSeek V4 thinking), OpenCode envoie toujours un `tool_choice` forcé pour la sortie structurée. opencode-mem désactive la réflexion sur l'agent interne `opencode-mem-structured` (et la ré-applique dans `chat.params` après fusion de variante) pour que l'auto-capture et l'apprentissage du profil puissent aboutir. Votre agent de chat interactif est inchangé. Si la capture échoue encore avec une erreur de réflexion/`tool_choice`, choisissez un modèle sans réflexion pour `opencodeModel` ou configurez un repli manuel complet (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code :** l'auto-capture utilise OpenCode avec votre fournisseur `anthropic` authentifié. Le `format: json_schema` forcé boucle souvent avec Claude-auth, si bien qu'opencode-mem utilise un chemin **texte-JSON** préservant l'authentification pour `opencodeProvider: "anthropic"` (pas d'outils `StructuredOutput` forcés ; la réponse est analysée avec Zod). Un watchdog d'étape interrompt toujours les sessions internes emballées après 2 étapes. Si la capture échoue encore, configurez un repli manuel complet à clé API Anthropic (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — l'OAuth Claude Pro/Max ne peut pas être réutilisé hors d'OpenCode.
- **Plateformes non prises en charge :** les Mac Intel (`darwin/x64`) ne sont pas pris en charge — `@tursodatabase/database` et les releases figées d'`onnxruntime-node` (`1.31.1` épinglée) ne livrent pas de binding natif x64. Utilisez Apple Silicon, Linux ou Windows, ou un endpoint d'embedding distant via `embeddingApiUrl` + `embeddingApiKey`. MLX n'est pas pris en charge.

## Exports publics de sous-chemins

En plus de l'entrée principale du plugin, `opencode-mem` expose un sous-chemin stable que d'autres plugins opencode peuvent importer directement. Cela évite d'avoir à rétro-concevoir les conventions de tags de conteneur en écrivant des outils tiers qui lisent ou écrivent dans le même store de mémoires.

### `opencode-mem/tags`

Aides canoniques aux tags de conteneur. Les mêmes fonctions qu'opencode-mem utilise lui-même pour borner les mémoires auto-capturées.

```ts
import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

// Tag de projet canonique dérivé du cwd (URL du remote git si présente, sinon
// le chemin racine du projet). Format : `opencode_project_<sha16>`.
const projectTag = getProjectTagInfo(process.cwd()).tag;

// Tag utilisateur canonique dérivé de `git config user.email`.
// Format : `opencode_user_<sha16>`.
const userTag = getUserTagInfo().tag;

// Les deux à la fois.
const { user, project } = getTags(process.cwd());
```

Les tags produits par ces aides correspondent à ce que l'auto-capture écrit, si bien que les plugins tiers qui appellent `POST /api/memories` atterrissent dans les mêmes shards que le reste du système comprend déjà. Les tags faits main dont la sous-chaîne n'est pas `_project_` ou `_user_` finissent dans des shards fantômes que `/api/stats` et `/api/memories` filtrent silencieusement — utiliser ces aides évite cet écueil.

## Développement et contribution

Buildez et testez localement :

```bash
bun install
bun run build
bun test
bun run check
```

`bun run check` exécute `format:check`, `lint` et `typecheck` ; `bun run format` réécrit le formatage.

Les [docs](https://opencode-mem.zhafron.my.id/docs/) sont générées depuis ce README et les traductions sous `.github/i18n/` ; la [page d'accueil](https://opencode-mem.zhafron.my.id) vit dans `github-site/src/`. Chaque titre du README doit être mappé à une page de docs dans `github-site/docs-map.json`, sinon le build du site échoue. Buildez le site localement avec `cd github-site && bun install && bun run build`.

Ce projet cherche activement des contributions pour devenir le plugin de mémoire de référence pour les agents de codage IA. Que vous corrigiez des bugs, ajoutiez des fonctionnalités, amélioriez la documentation ou élargissiez le support des modèles d'embedding, vos contributions sont essentielles. La base de code est bien structurée et prête à être enrichie. Ouvrez des issues avec les gabarits Issue ou Feature request, et remplissez le gabarit de pull request quand vous soumettez une PR — nous examinons et fusionnons les contributions rapidement.

**Traductions du README :** `README.md` (anglais) est la source de vérité. Quand vous changez son contenu, mettez à jour les fichiers sous `.github/i18n/` (`README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md`, `README.nl.md` et `README.fr.md`) pour qu'ils correspondent.

## Licence et liens

Licence MIT - voir le fichier LICENSE

- **Site web** : https://opencode-mem.zhafron.my.id
- **Docs** : https://opencode-mem.zhafron.my.id/docs/
- **Dépôt** : https://github.com/tickernelz/opencode-mem
- **Issues** : https://github.com/tickernelz/opencode-mem/issues
- **npm** : https://www.npmjs.com/package/opencode-mem
- **Plateforme OpenCode** : https://opencode.ai

Inspiré par [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)