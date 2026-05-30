const translations = {
  en: {
    title: "┌─ OPENCODE MEMORY EXPLORER ─┐",
    "tab-project": "PROJECT MEMORIES",
    "tab-profile": "USER PROFILE",
    "label-tag": "Tag:",
    "label-type": "Type:",
    "label-tags": "Tags:",
    "label-content": "Content:",
    "btn-cleanup": "Cleanup",
    "btn-deduplicate": "Deduplicate",
    "btn-delete-selected": "Delete Selected",
    "btn-select-all": "Select Page",
    "btn-deselect-all": "Deselect All",
    "btn-add-memory": "Add Memory",
    "section-project": "└─ PROJECT MEMORIES ({count}) ──",
    "section-profile": "└─ USER PROFILE ──",
    "section-add": "└─ ADD NEW MEMORY ──",
    "opt-all-tags": "All Tags",
    "opt-select-tag": "Select tag",
    "opt-other": "other",
    "opt-feature": "feature",
    "opt-bug-fix": "bug-fix",
    "opt-refactor": "refactor",
    "opt-architecture": "architecture",
    "opt-rule": "rule",
    "opt-documentation": "documentation",
    "opt-discussion": "discussion",
    "opt-analysis": "analysis",
    "opt-configuration": "configuration",
    "modal-edit-title": "Edit Memory",
    "modal-migration-title": "Memory Tagging Migration",
    "modal-changelog-title": "Profile Version History",
    "btn-cancel": "Cancel",
    "btn-save": "Save Changes",
    "btn-start-migration": "Start Migration",
    "loading-init": "Initializing...",
    "loading-profile": "Loading profile...",
    "loading-changelog": "Loading changelog...",
    "migration-mismatch": "Model dimension mismatch detected!",
    "migration-understand":
      "I understand this operation is irreversible and will affect all stored memories",
    "btn-fresh-start": "Fresh Start (Delete All)",
    "btn-reembed": "Re-embed (Preserve Data)",
    "migration-note":
      "Please don't close the browser. This will re-vectorize your memories with technical tags to improve search accuracy.",
    "placeholder-search": "Search memories...",
    "placeholder-tags": "react, hooks, auth (comma separated)",
    "placeholder-content": "Enter memory content...",
    "toast-add-success": "Memory added successfully",
    "toast-add-error": "Content and tag are required",
    "toast-add-failed": "Failed to add memory",
    "toast-delete-success": "Memory deleted successfully",
    "toast-delete-failed": "Failed to delete memory",
    "toast-update-success": "Memory updated successfully",
    "toast-update-failed": "Failed to update memory",
    "toast-cleanup-success": "Cleanup completed successfully",
    "toast-cleanup-failed": "Cleanup failed",
    "toast-dedup-success": "Deduplication completed successfully",
    "toast-dedup-failed": "Deduplication failed",
    "toast-bulk-delete-success": "Selected memories deleted successfully",
    "toast-bulk-delete-failed": "Failed to delete selected memories",
    "toast-migration-success": "Migration completed successfully",
    "toast-migration-failed": "Migration failed",
    "toast-fresh-start-success": "Fresh start completed successfully",
    "toast-fresh-start-failed": "Fresh start failed",
    "confirm-delete": "Delete this memory?",
    "confirm-delete-pair": "Delete this memory AND its linked prompt?",
    "confirm-delete-prompt": "Delete this prompt AND its linked memory?",
    "confirm-bulk-delete": "Delete {count} selected memories?",
    "confirm-cleanup": "This will remove all memories that are no longer relevant. Continue?",
    "confirm-dedup": "This will merge duplicate or highly similar memories. Continue?",
    "text-selected": "{count} selected",
    "text-page": "Page {current} of {total}",
    "text-total": "Total: {count}",
    "empty-memories": "No memories found",
    "empty-changelog": "No changelog available",
    "status-cleanup": "Running cleanup...",
    "status-dedup": "Running deduplication...",
    "status-migration-init": "Initializing migration...",
    "status-migration-progress": "Migrating... {current}/{total}",
    "profile-version": "VERSION",
    "profile-prompts": "PROMPTS",
    "profile-updated": "LAST UPDATED",
    "profile-preferences": "PREFERENCES",
    "profile-patterns": "PATTERNS",
    "profile-workflows": "WORKFLOWS",
    "badge-prompt": "USER PROMPT",
    "badge-memory": "MEMORY",
    "badge-pinned": "PINNED",
    "badge-linked": "LINKED",
    "date-created": "Created:",
    "date-updated": "Updated:",
    "empty-preferences": "No preferences learned yet",
    "empty-patterns": "No patterns detected yet",
    "empty-workflows": "No workflows identified yet",
    "btn-delete-pair": "Delete Pair",
    "btn-delete": "Delete",
    "text-generated-above": "Generated memory above",
    "text-from-below": "From prompt below",
    "btn-refresh": "Refresh",
    "migration-found-tags": "Found {count} memories needing technical tags.",
    "migration-stopped": "Migration stopped: maximum attempts reached",
    "migration-shards-mismatch": "{count} shard(s) have different dimensions",
    "migration-dimension-mismatch": "dimension mismatch detected",
    "migration-mismatch-details":
      "Model mismatch: Config uses {configDimensions}D ({configModel}), but {shardInfo}.",
  },
  zh: {
    title: "┌─ OPENCODE MEMORY EXPLORER ─┐",
    "tab-project": "项目记忆",
    "tab-profile": "用户画像",
    "label-tag": "标签:",
    "label-type": "类型:",
    "label-tags": "标签:",
    "label-content": "内容:",
    "btn-cleanup": "清理",
    "btn-deduplicate": "去重",
    "btn-delete-selected": "删除选中",
    "btn-select-all": "全选当前页",
    "btn-deselect-all": "取消全选",
    "btn-add-memory": "添加记忆",
    "section-project": "└─ 项目记忆 ({count}) ──",
    "section-profile": "└─ 用户画像 ──",
    "section-add": "└─ 添加新记忆 ──",
    "opt-all-tags": "所有标签",
    "opt-select-tag": "选择标签",
    "opt-other": "其他 (other)",
    "opt-feature": "功能 (feature)",
    "opt-bug-fix": "修复 (bug-fix)",
    "opt-refactor": "重构 (refactor)",
    "opt-architecture": "架构 (architecture)",
    "opt-rule": "规则 (rule)",
    "opt-documentation": "文档 (documentation)",
    "opt-discussion": "讨论 (discussion)",
    "opt-analysis": "分析 (analysis)",
    "opt-configuration": "配置 (configuration)",
    "modal-edit-title": "编辑记忆",
    "modal-migration-title": "记忆标签迁移",
    "modal-changelog-title": "画像版本历史",
    "btn-cancel": "取消",
    "btn-save": "保存更改",
    "btn-start-migration": "开始迁移",
    "loading-init": "初始化中...",
    "loading-profile": "加载画像中...",
    "loading-changelog": "加载更新日志中...",
    "migration-mismatch": "检测到模型维度不匹配！",
    "migration-understand": "我了解此操作不可逆，并将影响所有存储的记忆",
    "btn-fresh-start": "重新开始 (删除所有)",
    "btn-reembed": "重新向量化 (保留数据)",
    "migration-note": "请不要关闭浏览器。这将使用技术标签重新向量化您的记忆，以提高搜索准确性。",
    "placeholder-search": "搜索记忆...",
    "placeholder-tags": "react, hooks, auth (逗号分隔)",
    "placeholder-content": "输入记忆内容...",
    "toast-add-success": "记忆添加成功",
    "toast-add-error": "内容和标签为必填项",
    "toast-add-failed": "添加记忆失败",
    "toast-delete-success": "记忆删除成功",
    "toast-delete-failed": "删除记忆失败",
    "toast-update-success": "记忆更新成功",
    "toast-update-failed": "更新记忆失败",
    "toast-cleanup-success": "清理完成",
    "toast-cleanup-failed": "清理失败",
    "toast-dedup-success": "去重完成",
    "toast-dedup-failed": "去重失败",
    "toast-bulk-delete-success": "选中的记忆删除成功",
    "toast-bulk-delete-failed": "删除选中的记忆失败",
    "toast-migration-success": "迁移完成",
    "toast-migration-failed": "迁移失败",
    "toast-fresh-start-success": "重新开始完成",
    "toast-fresh-start-failed": "重新开始失败",
    "confirm-delete": "删除这条记忆？",
    "confirm-delete-pair": "删除这条记忆及其关联的提示词？",
    "confirm-delete-prompt": "删除这条提示词及其关联的记忆？",
    "confirm-bulk-delete": "删除选中的 {count} 条记忆？",
    "confirm-cleanup": "这将删除所有不再相关的记忆。是否继续？",
    "confirm-dedup": "这将合并重复或高度相似的记忆。是否继续？",
    "text-selected": "已选择 {count} 条",
    "text-page": "第 {current} 页，共 {total} 页",
    "text-total": "总计: {count}",
    "empty-memories": "未找到记忆",
    "empty-changelog": "暂无更新日志",
    "status-cleanup": "正在运行清理...",
    "status-dedup": "正在运行去重...",
    "status-migration-init": "正在初始化迁移...",
    "status-migration-progress": "迁移中... {current}/{total}",
    "profile-version": "版本",
    "profile-prompts": "提示词数",
    "profile-updated": "最后更新",
    "profile-preferences": "偏好设置",
    "profile-patterns": "行为模式",
    "profile-workflows": "工作流程",
    "badge-prompt": "用户提示词",
    "badge-memory": "记忆",
    "badge-pinned": "已置顶",
    "badge-linked": "已关联",
    "date-created": "创建于:",
    "date-updated": "更新于:",
    "empty-preferences": "尚未学习到偏好设置",
    "empty-patterns": "尚未检测到行为模式",
    "empty-workflows": "尚未识别出工作流程",
    "btn-delete-pair": "删除组合",
    "btn-delete": "删除",
    "text-generated-above": "由上方记忆生成",
    "text-from-below": "来自下方提示词",
    "btn-refresh": "刷新",
    "migration-found-tags": "发现 {count} 条需要技术标签的记忆。",
    "migration-stopped": "迁移已停止：达到最大尝试次数",
    "migration-shards-mismatch": "{count} 个分片具有不同的维度",
    "migration-dimension-mismatch": "检测到维度不匹配",
    "migration-mismatch-details":
      "模型不匹配：配置使用 {configDimensions}D ({configModel})，但{shardInfo}。",
  },
  ar: {
    title: "┌─ مستكشف ذاكرة OpenCode ─┐",
    "tab-project": "ذكريات المشروع",
    "tab-profile": "ملف المستخدم",

    "label-tag": "الوسم:",
    "label-type": "النوع:",
    "label-tags": "الوسوم:",
    "label-content": "المحتوى:",

    "btn-cleanup": "تنظيف",
    "btn-deduplicate": "إزالة التكرار",
    "btn-delete-selected": "حذف المحدد",
    "btn-select-all": "تحديد الصفحة",
    "btn-deselect-all": "إلغاء التحديد",
    "btn-add-memory": "إضافة ذكرى",

    "section-project": "└─ ذكريات المشروع ({count}) ──",
    "section-profile": "└─ ملف المستخدم ──",
    "section-add": "└─ إضافة ذكرى جديدة ──",

    "opt-all-tags": "جميع الوسوم",
    "opt-select-tag": "اختر وسمًا",
    "opt-other": "أخرى",
    "opt-feature": "ميزة",
    "opt-bug-fix": "إصلاح خطأ",
    "opt-refactor": "إعادة هيكلة",
    "opt-architecture": "معمارية",
    "opt-rule": "قاعدة",
    "opt-documentation": "توثيق",
    "opt-discussion": "نقاش",
    "opt-analysis": "تحليل",
    "opt-configuration": "إعدادات",

    "modal-edit-title": "تعديل الذكرى",
    "modal-migration-title": "ترحيل وسوم الذكريات",
    "modal-changelog-title": "سجل إصدارات الملف الشخصي",

    "btn-cancel": "إلغاء",
    "btn-save": "حفظ التغييرات",
    "btn-start-migration": "بدء الترحيل",

    "loading-init": "جاري التهيئة...",
    "loading-profile": "جاري تحميل الملف الشخصي...",
    "loading-changelog": "جاري تحميل السجل...",

    "migration-mismatch": "تم اكتشاف عدم تطابق في أبعاد النموذج!",
    "migration-understand":
      "أفهم أن هذه العملية غير قابلة للتراجع وستؤثر على جميع الذكريات المخزنة",

    "btn-fresh-start": "بداية جديدة (حذف الكل)",
    "btn-reembed": "إعادة إنشاء المتجهات (مع الاحتفاظ بالبيانات)",

    "migration-note":
      "يرجى عدم إغلاق المتصفح. سيتم إعادة فهرسة الذكريات باستخدام وسوم تقنية لتحسين دقة البحث.",

    "placeholder-search": "ابحث في الذكريات...",
    "placeholder-tags": "react, hooks, auth (مفصولة بفواصل)",
    "placeholder-content": "أدخل محتوى الذكرى...",

    "toast-add-success": "تمت إضافة الذكرى بنجاح",
    "toast-add-error": "المحتوى والوسم مطلوبان",
    "toast-add-failed": "فشلت إضافة الذكرى",

    "toast-delete-success": "تم حذف الذكرى بنجاح",
    "toast-delete-failed": "فشل حذف الذكرى",

    "toast-update-success": "تم تحديث الذكرى بنجاح",
    "toast-update-failed": "فشل تحديث الذكرى",

    "toast-cleanup-success": "اكتملت عملية التنظيف بنجاح",
    "toast-cleanup-failed": "فشلت عملية التنظيف",

    "toast-dedup-success": "اكتملت إزالة التكرار بنجاح",
    "toast-dedup-failed": "فشلت إزالة التكرار",

    "toast-bulk-delete-success": "تم حذف الذكريات المحددة بنجاح",
    "toast-bulk-delete-failed": "فشل حذف الذكريات المحددة",

    "toast-migration-success": "اكتملت عملية الترحيل بنجاح",
    "toast-migration-failed": "فشلت عملية الترحيل",

    "toast-fresh-start-success": "تمت البداية الجديدة بنجاح",
    "toast-fresh-start-failed": "فشلت البداية الجديدة",

    "confirm-delete": "هل تريد حذف هذه الذكرى؟",
    "confirm-delete-pair": "هل تريد حذف هذه الذكرى والموجه المرتبط بها؟",
    "confirm-delete-prompt": "هل تريد حذف هذا الموجه والذكرى المرتبطة به؟",

    "confirm-bulk-delete": "هل تريد حذف {count} من الذكريات المحددة؟",

    "confirm-cleanup": "سيؤدي هذا إلى حذف جميع الذكريات التي لم تعد ذات صلة. هل تريد المتابعة؟",

    "confirm-dedup": "سيؤدي هذا إلى دمج الذكريات المتكررة أو المتشابهة جدًا. هل تريد المتابعة؟",

    "text-selected": "تم تحديد {count}",
    "text-page": "الصفحة {current} من {total}",
    "text-total": "الإجمالي: {count}",

    "empty-memories": "لم يتم العثور على ذكريات",
    "empty-changelog": "لا يوجد سجل تغييرات",

    "status-cleanup": "جاري التنظيف...",
    "status-dedup": "جاري إزالة التكرار...",
    "status-migration-init": "جاري تهيئة الترحيل...",
    "status-migration-progress": "جاري الترحيل... {current}/{total}",

    "profile-version": "الإصدار",
    "profile-prompts": "الموجهات",
    "profile-updated": "آخر تحديث",
    "profile-preferences": "التفضيلات",
    "profile-patterns": "الأنماط",
    "profile-workflows": "سير العمل",

    "badge-prompt": "موجه المستخدم",
    "badge-memory": "ذكرى",
    "badge-pinned": "مثبتة",
    "badge-linked": "مرتبطة",

    "date-created": "تاريخ الإنشاء:",
    "date-updated": "تاريخ التحديث:",

    "empty-preferences": "لم يتم تعلم أي تفضيلات بعد",
    "empty-patterns": "لم يتم اكتشاف أي أنماط بعد",
    "empty-workflows": "لم يتم التعرف على أي سير عمل بعد",

    "btn-delete-pair": "حذف الزوج",
    "btn-delete": "حذف",

    "text-generated-above": "تم إنشاء الذكرى أعلاه",
    "text-from-below": "من الموجه أدناه",

    "btn-refresh": "تحديث",

    "migration-found-tags": "تم العثور على {count} من الذكريات التي تحتاج إلى وسوم تقنية.",

    "migration-stopped": "تم إيقاف الترحيل: تم الوصول إلى الحد الأقصى للمحاولات",

    "migration-shards-mismatch": "{count} من الأجزاء تحتوي على أبعاد مختلفة",

    "migration-dimension-mismatch": "تم اكتشاف عدم تطابق في الأبعاد",

    "migration-mismatch-details":
      "عدم تطابق النموذج: يستخدم الإعداد {configDimensions}D ({configModel}) بينما {shardInfo}.",
  },
};

function getLanguage() {
  return localStorage.getItem("opencode-mem-lang") || "en";
}

function setLanguage(lang) {
  localStorage.setItem("opencode-mem-lang", lang);

  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

  document.documentElement.lang = lang;

  applyLanguage();
}

function t(key, params = {}) {
  const lang = getLanguage();
  let text = translations[lang][key] || translations["en"][key] || key;

  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }

  return text;
}

function applyLanguage() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const translated = t(key);

    // If element has child nodes (like icons), we need to replace only the text nodes
    if (el.children.length > 0) {
      let textNodeFound = false;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "") {
          node.textContent = " " + translated + " ";
          textNodeFound = true;
        }
      }
      if (!textNodeFound) {
        el.appendChild(document.createTextNode(" " + translated));
      }
    } else {
      el.textContent = translated;
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.setAttribute("placeholder", t(key));
  });
}

window.t = t;
window.getLanguage = getLanguage;
window.setLanguage = setLanguage;
window.applyLanguage = applyLanguage;
