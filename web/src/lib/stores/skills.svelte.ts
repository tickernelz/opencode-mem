import { toast } from "$lib/toast/toast.svelte";
import { fetchAPI, toastApiResult } from "$lib/api";
import { t } from "$lib/i18n";
import { askConfirm } from "$lib/confirm.svelte";
import { allocateSkillId } from "$lib/skill-id";

export type SkillItem = {
  id: string;
  name: string;
  description: string;
  content: string;
  autoinvoke: boolean;
  enabled: boolean;
  containerTag: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillDraft = {
  name: string;
  description: string;
  content: string;
  autoinvoke: boolean;
  enabled: boolean;
};

function emptyDraft(): SkillDraft {
  return {
    name: "",
    description: "",
    content: "",
    autoinvoke: true,
    enabled: true,
  };
}

export function createSkillsStore() {
  let skills = $state<SkillItem[]>([]);
  let loading = $state(false);
  let dialogOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state<SkillDraft>(emptyDraft());
  let searchInput = $state("");

  const filteredSkills = $derived.by(() => {
    const query = searchInput.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => {
      const haystack = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  const isSearching = $derived(searchInput.trim().length > 0);

  async function loadSkills() {
    loading = true;
    const result = await fetchAPI<{ items: SkillItem[] }>("/api/skills");
    loading = false;
    if (!result.success || !result.data) {
      await toastApiResult(result, { failKey: "toast-skill-load-failed" });
      return;
    }
    skills = result.data.items;
  }

  function openCreate() {
    editingId = null;
    draft = emptyDraft();
    dialogOpen = true;
  }

  function openEdit(skill: SkillItem) {
    editingId = skill.id;
    draft = {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      autoinvoke: skill.autoinvoke,
      enabled: skill.enabled,
    };
    dialogOpen = true;
  }

  async function saveSkill() {
    const name = draft.name.trim();
    const description = draft.description.trim();
    const content = draft.content;
    if (!name || !content.trim()) {
      toast.error(t("toast-skill-save-failed"));
      return;
    }

    const body = {
      name,
      description,
      content,
      autoinvoke: draft.autoinvoke,
      enabled: draft.enabled,
    };

    const result = editingId
      ? await fetchAPI<SkillItem>(`/api/skills/${encodeURIComponent(editingId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      : await fetchAPI<SkillItem>("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            id: allocateSkillId(
              name,
              skills.map((s) => s.id)
            ),
          }),
        });

    await toastApiResult(result, {
      successKey: "toast-skill-save-success",
      failKey: "toast-skill-save-failed",
      onSuccess: async () => {
        dialogOpen = false;
        await loadSkills();
      },
    });
  }

  async function deleteSkill(id: string) {
    const skill = skills.find((s) => s.id === id);
    const ok = await askConfirm({
      title: t("confirm-delete-title"),
      detail: t("confirm-delete-skill", { name: skill?.name ?? id }),
      confirmLabel: t("btn-delete-selected"),
      cancelLabel: t("btn-cancel"),
      tone: "danger",
    });
    if (!ok) return;
    const result = await fetchAPI(`/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await toastApiResult(result, {
      successKey: "toast-skill-delete-success",
      failKey: "toast-skill-delete-failed",
      onSuccess: () => loadSkills(),
    });
  }

  function clearSearch() {
    searchInput = "";
  }

  return {
    get skills() {
      return skills;
    },
    get filteredSkills() {
      return filteredSkills;
    },
    get loading() {
      return loading;
    },
    get dialogOpen() {
      return dialogOpen;
    },
    set dialogOpen(v: boolean) {
      dialogOpen = v;
    },
    get editingId() {
      return editingId;
    },
    get draft() {
      return draft;
    },
    set draft(v: SkillDraft) {
      draft = v;
    },
    get searchInput() {
      return searchInput;
    },
    set searchInput(v: string) {
      searchInput = v;
    },
    get isSearching() {
      return isSearching;
    },
    loadSkills,
    openCreate,
    openEdit,
    saveSkill,
    deleteSkill,
    clearSearch,
  };
}

export type SkillsStore = ReturnType<typeof createSkillsStore>;
