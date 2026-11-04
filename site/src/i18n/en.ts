export const en = {
  meta: {
    title: "opencode-mem: your OpenCode agent finally remembers",
    description:
      "opencode-mem gives OpenCode a long-term memory. It writes down decisions, fixes, and preferences while you work, and brings them back next session. Free, open source, and stored on your machine.",
  },
  nav: {
    how: "How it works",
    features: "Features",
    faq: "FAQ",
    docs: "Docs",
    github: "GitHub",
    theme: "Switch color theme",
    skip: "Skip to content",
  },
  hero: {
    title: "Your agent finally remembers.",
    lede: "opencode-mem gives OpenCode a long-term memory. It writes down what matters while you work and hands it back the moment it is useful again. Stop re‑explaining your codebase every Monday.",
    primary: "Install in under a minute",
    secondary: "Star on GitHub",
    small: "Free and open source. MIT licensed. Stored on your machine.",
    figureLabel: "Illustration: an agent recalls a rule you set two weeks earlier",
    caption: "Illustration. A session two weeks after you set the rule.",
    you: "you",
    agent: "agent",
    ask: "Add a delete button to the invoices page.",
    answer:
      "Done. It opens the in-app confirmation modal, not the browser confirm(). You asked for that two weeks ago.",
    recalled: "recalled from memory",
    memory: "rule · never use the browser confirm() for destructive actions",
  },
  contrast: {
    title: "Every new session starts from zero. Until now.",
    lede: "Your agent is brilliant for an hour, then forgets everything. So you repeat yourself. Again.",
    withoutLabel: "Without opencode-mem",
    withLabel: "With opencode-mem",
    without: [
      "We use pnpm here, not npm.",
      "No, the shared types live in packages/shared.",
      "We tried that retry fix last week. It broke the build.",
      "Please never use the browser confirm() dialog.",
    ],
    with: [
      "Running pnpm test.",
      "Importing the types from packages/shared.",
      "Skipping the retry fix: it broke the build last time.",
      "Using the in-app modal for the delete flow.",
    ],
    withoutFoot: "You, explaining it all again.",
    withFoot: "You, shipping.",
  },
  how: {
    title: "Three steps. Two of them you already do.",
    steps: [
      {
        title: "Add one line",
        body: "Put opencode-mem in your OpenCode config and restart. OpenCode installs it from npm for you.",
      },
      {
        title: "Work like you always do",
        body: "When a session goes quiet, Auto-capture writes down the decisions, fixes, and preferences worth keeping. You never have to say “remember this”.",
      },
      {
        title: "Pick up where you left off",
        body: "Next session, the right memories are already in your agent's context. Nothing pasted into your prompt, nothing cluttering the chat.",
      },
    ],
    captureLabel: "Illustration: a session is summarized into a memory that joins the memory graph",
    sessions: [
      {
        lines: [
          ["you", "the build fails on CI but passes locally"],
          ["agent", "CI runs Node 20; the lockfile was made with Node 24. Pinned engines to 24."],
          ["you", "nice, that was it"],
        ],
        memory: "CI must use Node 24, same as the lockfile",
        tag: "bug-fix",
      },
      {
        lines: [
          ["you", "keep PRs small, one concern each"],
          ["agent", "Split it into three PRs: schema, API, UI."],
          ["you", "perfect"],
        ],
        memory: "Prefers small PRs, one concern each",
        tag: "preference",
      },
      {
        lines: [
          ["you", "why did we drop Redis again?"],
          ["agent", "Checked the ADR: one less service to run. SQLite queue is enough."],
          ["you", "right, keep it that way"],
        ],
        memory: "Queue stays on SQLite; Redis was removed on purpose",
        tag: "decision",
      },
    ],
    idle: "session idle · auto-capture",
  },
  install: {
    title: "Install in under a minute",
    lede: "One line in your OpenCode config, then restart. The plugin writes a commented settings file on first start.",
    v2: "OpenCode v2",
    v1: "OpenCode v1",
    v2File: "opencode.json",
    v1File: "~/.config/opencode/opencode.json",
    v2Code: '{\n  "plugins": ["opencode-mem@latest"]\n}',
    v1Code: '{\n  "plugin": ["opencode-mem@latest"]\n}',
    providerLead:
      "Then tell Auto-capture which provider to summarize with. inherit follows the model of your session.",
    providerFile: "~/.config/opencode/opencode-mem.jsonc",
    providerCode: '{\n  "opencodeProvider": "anthropic",\n  "opencodeModel": "inherit"\n}',
    copy: "Copy",
    copied: "Copied",
    more: "Full setup guide",
  },
  features: {
    title: "A memory you can see, edit, and trust.",
    lede: "Everything opencode-mem keeps is yours to browse, pin, fix, or throw away.",
    items: [
      ["Auto-capture", "Writes memories for you when a session goes idle."],
      ["User Profile", "Learns how you like to work, across every project."],
      ["Web UI", "Browse, edit, pin, and delete memories at localhost:4747."],
      ["Markdown vault", "Keep memories as plain .md files in a folder you already use."],
      [
        "Update-on-capture",
        "When a fact changes, the old memory is updated instead of duplicated.",
      ],
      ["Dreaming", "Merges overlapping memories and flags the ones that disagree."],
      ["Shared Skills", "Write a procedure once. Your agent loads it when it needs it."],
      ["Health stats", "Captures, injections, and errors for the last 14 days at a glance."],
      ["Memory Scope", "Search this project, or everything you have ever worked on."],
    ],
  },
  dream: {
    title: "It tidies up while you are away.",
    body: "Turn on Dreaming and once a day opencode-mem finds memories that say the same thing, merges them, and flags the ones that contradict each other. Superseded memories go to a trash you can restore. Pinned memories are never touched.",
    label:
      "Illustration: small related memories merge into brighter ones while a contradiction is flagged",
    legend: ["merged", "flagged", "kept in trash"],
  },
  nested: {
    title: "Many repos. One memory.",
    body: "A monorepo, a repo-tool workspace, a folder of services that belong together: drop one empty .opencode-mem-project file at the root and every repository underneath shares the same memory.",
    label: "Three nested repositories connected to one shared memory",
    root: "my-workspace/",
    repos: ["kernel/", "userspace/", "tools/"],
    shared: "one shared memory",
  },
  showcase: {
    title: "Open the drawer. It is all there.",
    lede: "A local web UI shows every memory, your profile, your skills, and the health of the whole system.",
    caption: "The real opencode-mem web UI (v{version}), running with sample data.",
    tabs: [
      ["memories", "Project memories"],
      ["profile", "User profile"],
      ["skills", "Skills"],
      ["stats", "Stats"],
    ],
  },
  privacy: {
    title: "Your memories live on your machine.",
    points: [
      [
        "No account, no cloud.",
        "Memories are stored on your disk, under ~/.opencode-mem by default.",
      ],
      [
        "Local embeddings.",
        "Search runs on your CPU out of the box. No GPU, no embedding API needed.",
      ],
      [
        "Loopback by default.",
        "The web UI listens on 127.0.0.1. Expose it to a network and an API token becomes mandatory.",
      ],
      [
        "Secrets stay out.",
        "Recognizable credentials are redacted before anything is summarized. Wrap anything else in <private>.",
      ],
      ["Encrypted if you want.", "Turn on AES-256-GCM encryption at rest with one setting."],
    ],
    note: "Auto-capture summarizes your session with the AI provider you choose, the same kind of request your agent already makes.",
  },
  hood: {
    title: "Under the hood",
    items: [
      "Embedded Turso/libSQL with native vector search, one shard per project",
      "Local embeddings via @huggingface/transformers on ONNX, default Xenova/nomic-embed-text-v1",
      "12+ local embedding models, or any OpenAI-compatible endpoint",
      "On OpenCode v2, memory context goes into the system context, not your prompt or transcript",
    ],
    link: "How storage and embeddings work",
  },
  proof: {
    title: "Open source. Check the numbers.",
    stars: "GitHub stars",
    forks: "forks",
    downloads: "npm downloads in the last 12 months",
    releases: "versions published, latest",
    source: "From the GitHub and npm APIs, fetched {date}.",
  },
  faq: {
    title: "Questions you might have",
    items: [
      [
        "Does my code leave my machine?",
        "Memories, embeddings, and the web UI stay local. The one outbound call is Auto-capture: it asks the AI provider you configure to summarize the session, much like your agent already does. Credentials are stripped first.",
      ],
      [
        "What does it cost?",
        "Nothing. opencode-mem is MIT licensed and free. The only cost is the tokens Auto-capture uses on your provider, so pick a small model or inherit the one you already pay for.",
      ],
      [
        "Will it work with my setup?",
        "It runs as an OpenCode plugin on v1 and v2, on Linux, Windows, and Apple Silicon Macs. Intel Macs are not supported because two native dependencies ship no x64 build there.",
      ],
      [
        "Do I need a GPU?",
        "No. Local embeddings run on CPU and use about 0.5 to 2 GB of RAM while loaded. Prefer zero local load? Point it at a remote embeddings API.",
      ],
      [
        "Do I have to tell it what to remember?",
        "No. Auto-capture handles it. When you want something saved right now, ask your agent to use the memory tool.",
      ],
      [
        "I already have AGENTS.md. Why this?",
        "Keep stable, always-on rules in AGENTS.md. Memory is for what grows: decisions, failed attempts, bug patterns, and your preferences. They work best together.",
      ],
      [
        "Can I see and fix what it stored?",
        "Yes. The web UI lists every memory with search, pin, edit, and delete, or switch to the Markdown vault and edit plain files.",
      ],
    ],
  },
  closing: {
    title: "Tomorrow's session already knows what today found out.",
    primary: "Install opencode-mem",
    secondary: "Read the docs",
  },
  footer: {
    statement: "Memory for coding agents, kept on your machine.",
    docs: "Docs",
    github: "GitHub",
    npm: "npm",
    issues: "Issues",
    releases: "Releases",
    license: "MIT License",
    inspired: "Inspired by opencode-supermemory",
  },
};

export type Copy = typeof en;
