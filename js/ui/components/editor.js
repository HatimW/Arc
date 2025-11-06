import { uid, setToggleState } from '../../utils.js';
import { upsertItem } from '../../storage/storage.js';
import { loadBlockCatalog } from '../../storage/block-catalog.js';
import { createFloatingWindow } from './window-manager.js';
import { createRichTextEditor } from './rich-text.js';
import { confirmModal } from './confirm.js';

const fieldMap = {
  disease: [
    ['etiology', 'Etiology'],
    ['pathophys', 'Pathophysiology'],
    ['clinical', 'Clinical Presentation'],
    ['diagnosis', 'Diagnosis'],
    ['treatment', 'Treatment'],
    ['complications', 'Complications'],
    ['mnemonic', 'Mnemonic']
  ],
  drug: [
    ['class', 'Class'],
    ['source', 'Source'],
    ['moa', 'MOA'],
    ['uses', 'Uses'],
    ['sideEffects', 'Side Effects'],
    ['contraindications', 'Contraindications'],
    ['mnemonic', 'Mnemonic']
  ],
  concept: [
    ['type', 'Type'],
    ['definition', 'Definition'],
    ['mechanism', 'Mechanism'],
    ['clinicalRelevance', 'Clinical Relevance'],
    ['example', 'Example'],
    ['mnemonic', 'Mnemonic']
  ]
};

const titleMap = { disease: 'Disease', drug: 'Drug', concept: 'Concept' };

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function openEditor(kind, onSave, existing = null) {
  let isDirty = false;
  let status;
  let statusFadeTimer = null;
  let autoSaveTimer = null;
  let idleSaveHandle = null;
  const AUTOSAVE_DELAY = 9000;
  const AUTOSAVE_IDLE_TIMEOUT = 15000;
  const runWhenIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
  const cancelIdle = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : null;
  const computePersistSignature = (item) => {
    if (!item || typeof item !== 'object') return null;
    try {
      return JSON.stringify(item);
    } catch (err) {
      return null;
    }
  };
  let lastPersistSignature = existing ? computePersistSignature(existing) : null;
  const editorCleanups = new Set();

  function registerCleanup(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    editorCleanups.add(fn);
    return () => {
      editorCleanups.delete(fn);
    };
  }

  function runEditorCleanups() {
    editorCleanups.forEach(fn => {
      try {
        fn();
      } catch (err) {
        console.error('Failed to cleanup editor resources', err);
      }
    });
    editorCleanups.clear();
  }

  function trackEditorInstance(editor) {
    if (!editor || typeof editor.destroy !== 'function') {
      return () => {};
    }
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      try {
        editor.destroy();
      } catch (err) {
        console.error('Failed to destroy rich text editor', err);
      }
    };
    const unregister = registerCleanup(cleanup);
    return () => {
      if (disposed) return;
      unregister();
      cleanup();
    };
  }

  const win = createFloatingWindow({
    title: `${existing ? 'Edit' : 'Add'} ${titleMap[kind] || kind}`,
    width: 660,
    onClose: () => {
      cancelAutoSave();
      if (statusFadeTimer) {
        clearTimeout(statusFadeTimer);
        statusFadeTimer = null;
      }
      runEditorCleanups();
    },
    onBeforeClose: async (reason) => {
      if (reason === 'saved') return true;
      cancelAutoSave();
      if (!isDirty) return true;
      if (reason !== 'close') return true;
      const shouldSave = await confirmModal('Save changes before closing?');
      if (shouldSave) {
        try {
          await persist({ closeAfter: true });
        } catch (err) {
          console.error(err);
        }
        return false;
      }
      return true;
    }
  });

  const form = document.createElement('form');
  form.className = 'editor-form';

  const nameLabel = document.createElement('label');
  nameLabel.className = 'editor-field';
  const nameTitle = document.createElement('span');
  nameTitle.className = 'editor-field-label';
  nameTitle.textContent = kind === 'concept' ? 'Concept' : 'Name';
  nameLabel.appendChild(nameTitle);
  const nameInput = document.createElement('input');
  nameInput.className = 'input';
  nameInput.value = existing ? (existing.name || existing.concept || '') : '';
  nameInput.placeholder = kind === 'concept' ? 'Enter concept title' : 'Enter name';
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const cancelAutoSave = () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (idleSaveHandle != null && cancelIdle) {
      cancelIdle(idleSaveHandle);
      idleSaveHandle = null;
    }
  };

  const queueAutoSave = () => {
    cancelAutoSave();
    if (!isDirty) return;
    if (!nameInput.value.trim()) return;
    if (!hasLectureSelection()) return;
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (!isDirty) return;
      if (!hasLectureSelection()) return;
      const attemptSave = () => {
        persist({ silent: true }).catch(err => {
          console.error('Autosave failed', err);
        });
      };
      if (runWhenIdle) {
        idleSaveHandle = runWhenIdle(() => {
          idleSaveHandle = null;
          attemptSave();
        }, { timeout: AUTOSAVE_IDLE_TIMEOUT });
      } else {
        attemptSave();
      }
    }, AUTOSAVE_DELAY);
  };

  const markDirty = () => {
    isDirty = true;
    if (status) {
      if (statusFadeTimer) {
        clearTimeout(statusFadeTimer);
        statusFadeTimer = null;
      }
      status.textContent = '';
      status.classList.remove('editor-status-muted');
    }
    queueAutoSave();
  };

  nameInput.addEventListener('input', markDirty);

  const fieldInputs = {};
  fieldMap[kind].forEach(([field, label]) => {
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'editor-field';

    const labelEl = document.createElement('label');
    labelEl.className = 'editor-field-label';
    labelEl.textContent = label;
    const labelId = `field-${field}-${uid()}`;
    labelEl.id = labelId;
    fieldWrap.appendChild(labelEl);

    const editor = createRichTextEditor({
      value: existing ? existing[field] || '' : '',
      onChange: markDirty,
      ariaLabelledBy: labelId
    });
    trackEditorInstance(editor);
    const inp = editor.element;
    fieldInputs[field] = editor;
    fieldWrap.appendChild(inp);
    form.appendChild(fieldWrap);
  });

  const extrasWrap = document.createElement('section');
  extrasWrap.className = 'editor-extras';
  const extrasHeader = document.createElement('div');
  extrasHeader.className = 'editor-extras-header';
  const extrasTitle = document.createElement('h3');
  extrasTitle.textContent = 'Custom Sections';
  extrasHeader.appendChild(extrasTitle);
  const addExtraBtn = document.createElement('button');
  addExtraBtn.type = 'button';
  addExtraBtn.className = 'btn subtle';
  addExtraBtn.textContent = 'Add Section';
  extrasHeader.appendChild(addExtraBtn);
  extrasWrap.appendChild(extrasHeader);

  const extrasList = document.createElement('div');
  extrasList.className = 'editor-extras-list';
  extrasWrap.appendChild(extrasList);
  form.appendChild(extrasWrap);

  const extraControls = new Map();

  function addExtra(extra = null) {
    const data = extra || {};
    const id = data.id || uid();
    const row = document.createElement('div');
    row.className = 'editor-extra';
    row.dataset.id = id;

    const titleRow = document.createElement('div');
    titleRow.className = 'editor-extra-title-row';
    const titleInput = document.createElement('input');
    titleInput.className = 'input editor-extra-title';
    titleInput.placeholder = 'Section title';
    titleInput.value = data.title || '';
    titleRow.appendChild(titleInput);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn ghost';
    removeBtn.title = 'Remove section';
    removeBtn.textContent = '✕';
    titleRow.appendChild(removeBtn);
    row.appendChild(titleRow);

    const editor = createRichTextEditor({ value: data.body || '', onChange: markDirty });
    const disposeEditor = trackEditorInstance(editor);
    row.appendChild(editor.element);
    extrasList.appendChild(row);
    extraControls.set(id, { id, titleInput, editor, dispose: disposeEditor });

    titleInput.addEventListener('input', markDirty);
    row.addEventListener('input', markDirty);
    if (!extra) markDirty();

    removeBtn.addEventListener('click', () => {
      extraControls.delete(id);
      disposeEditor();
      row.remove();
      markDirty();
    });
  }

  addExtraBtn.addEventListener('click', () => addExtra());

  const legacyExtras = (() => {
    if (existing?.extras && existing.extras.length) return existing.extras;
    if (existing?.facts && existing.facts.length) {
      return [{
        id: uid(),
        title: 'Highlights',
        body: existing.facts.map(f => `<p>${escapeHtml(f)}</p>`).join('')
      }];
    }
    return [];
  })();

  legacyExtras.forEach(extra => addExtra(extra));

  const colorLabel = document.createElement('label');
  colorLabel.className = 'editor-field';
  colorLabel.textContent = 'Color';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'input';
  colorInput.value = existing?.color || '#ffffff';
  colorLabel.appendChild(colorInput);
  form.appendChild(colorLabel);
  colorInput.addEventListener('input', markDirty);

  const catalog = await loadBlockCatalog({ force: true });
  const blocks = (catalog.blocks || []).map(block => ({
    ...block,
    lectures: (catalog.lectureLists?.[block.blockId] || []).map(lecture => ({ ...lecture }))
  }));
  const blockMap = new Map(blocks.map(b => [b.blockId, b]));
  const blockSet = new Set(Array.isArray(existing?.blocks) ? existing.blocks : []);
  const manualWeeks = new Set(
    Array.isArray(existing?.weeks)
      ? existing.weeks.filter(value => Number.isFinite(Number(value))).map(value => Number(value))
      : []
  );
  const lectSet = new Set();
  const lectureBlockCounts = new Map();

  function hasLectureSelection() {
    if (lectSet.size > 0) return true;
    return Array.isArray(existing?.lectures) && existing.lectures.length > 0;
  }

  function incrementBlockCount(blockId) {
    if (!blockId) return;
    const key = String(blockId);
    const next = (lectureBlockCounts.get(key) || 0) + 1;
    lectureBlockCounts.set(key, next);
  }

  function decrementBlockCount(blockId) {
    if (!blockId) return;
    const key = String(blockId);
    const prev = lectureBlockCounts.get(key) || 0;
    if (prev <= 1) {
      lectureBlockCounts.delete(key);
    } else {
      lectureBlockCounts.set(key, prev - 1);
    }
  }

  existing?.lectures?.forEach(l => {
    if (l.blockId != null && l.id != null) {
      const key = `${l.blockId}|${l.id}`;
      lectSet.add(key);
      incrementBlockCount(l.blockId);
    }
  });

  const blockWrap = document.createElement('section');
  blockWrap.className = 'editor-tags';
  const blockTitle = document.createElement('div');
  blockTitle.className = 'editor-tags-title';
  blockTitle.textContent = 'Curriculum tags';
  blockWrap.appendChild(blockTitle);

  const blockDescription = document.createElement('p');
  blockDescription.className = 'editor-tags-description';
  blockDescription.textContent = 'Pick the lectures that relate to this entry. Block and week tags update automatically as you choose lectures.';
  blockWrap.appendChild(blockDescription);

  const blockChipRow = document.createElement('div');
  blockChipRow.className = 'editor-chip-row';
  blockWrap.appendChild(blockChipRow);

  const manualWeeksBox = document.createElement('div');
  manualWeeksBox.className = 'editor-manual-weeks';
  const manualWeeksHeader = document.createElement('div');
  manualWeeksHeader.className = 'editor-manual-weeks-header';
  const manualWeeksTitle = document.createElement('span');
  manualWeeksTitle.textContent = 'Additional week tags';
  manualWeeksHeader.appendChild(manualWeeksTitle);
  manualWeeksBox.appendChild(manualWeeksHeader);
  const manualWeekList = document.createElement('div');
  manualWeekList.className = 'editor-manual-weeks-list';
  manualWeeksBox.appendChild(manualWeekList);
  const blockBrowser = document.createElement('div');
  blockBrowser.className = 'editor-curriculum-browser';
  blockWrap.appendChild(blockBrowser);

  const runNextFrame = typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);

  let scheduledRender = null;
  function scheduleRender({ chips = false, blocks = false, weeks = false, lectures = false } = {}) {
    if (!scheduledRender) {
      scheduledRender = { chips, blocks, weeks, lectures };
      runNextFrame(() => {
        const payload = scheduledRender;
        scheduledRender = null;
        if (payload.chips) renderBlockChips();
        if (payload.blocks) renderBlockList();
        if (payload.weeks) renderWeekList();
        if (payload.lectures) renderLectureList();
      });
      return;
    }
    if (chips) scheduledRender.chips = true;
    if (blocks) scheduledRender.blocks = true;
    if (weeks) scheduledRender.weeks = true;
    if (lectures) scheduledRender.lectures = true;
  }

  const blockColumn = document.createElement('div');
  blockColumn.className = 'editor-curriculum-column editor-block-column';
  const blockColumnHeading = document.createElement('h4');
  blockColumnHeading.className = 'editor-column-heading';
  blockColumnHeading.textContent = 'Blocks';
  blockColumn.appendChild(blockColumnHeading);
  const blockListEl = document.createElement('div');
  blockListEl.className = 'editor-block-list';
  blockColumn.appendChild(blockListEl);
  blockBrowser.appendChild(blockColumn);

  const weekColumn = document.createElement('div');
  weekColumn.className = 'editor-curriculum-column editor-week-column';
  const weekHeading = document.createElement('h4');
  weekHeading.className = 'editor-column-heading';
  weekHeading.textContent = 'Weeks';
  weekColumn.appendChild(weekHeading);
  const weekListEl = document.createElement('div');
  weekListEl.className = 'editor-week-browser';
  weekColumn.appendChild(weekListEl);
  weekColumn.appendChild(manualWeeksBox);
  blockBrowser.appendChild(weekColumn);

  const lectureColumn = document.createElement('div');
  lectureColumn.className = 'editor-curriculum-column editor-lecture-column';
  const lectureHeading = document.createElement('h4');
  lectureHeading.className = 'editor-column-heading';
  lectureHeading.textContent = 'Lectures';
  lectureColumn.appendChild(lectureHeading);
  const lectureListEl = document.createElement('div');
  lectureListEl.className = 'editor-lecture-browser';
  lectureColumn.appendChild(lectureListEl);
  blockBrowser.appendChild(lectureColumn);

  const UNSCHEDULED_KEY = '__unscheduled';

  function createTagChip(label, variant, active = false) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `tag-chip tag-chip-${variant}`;
    chip.textContent = label;
    setToggleState(chip, active);
    return chip;
  }

  function blockHasSelectedLectures(blockId) {
    if (!blockId) return false;
    return lectureBlockCounts.has(String(blockId));
  }

  function collectSelectedWeekKeys() {
    const selected = new Set();
    lectSet.forEach(key => {
      const [blockId, lectureId] = key.split('|');
      const lecId = Number(lectureId);
      if (!blockId || !Number.isFinite(lecId)) return;
      const block = blockMap.get(blockId);
      const lecture = block?.lectures?.find(le => le.id === lecId);
      if (!lecture) return;
      const weekValue = lecture.week == null || lecture.week === '' ? UNSCHEDULED_KEY : lecture.week;
      selected.add(`${blockId}|${weekValue}`);
    });
    return selected;
  }

  function collectWeekNumbers() {
    const numbers = new Set(manualWeeks);
    lectSet.forEach(key => {
      const [blockId, lectureId] = key.split('|');
      const lecId = Number(lectureId);
      if (!blockId || !Number.isFinite(lecId)) return;
      const block = blockMap.get(blockId);
      const lecture = block?.lectures?.find(le => le.id === lecId);
      if (!lecture) return;
      const weekValue = Number(lecture.week);
      if (Number.isFinite(weekValue)) numbers.add(weekValue);
    });
    return numbers;
  }

  function renderManualWeekTags() {
    manualWeekList.innerHTML = '';
    if (!manualWeeks.size) {
      const empty = document.createElement('span');
      empty.className = 'editor-manual-weeks-empty';
      empty.textContent = 'No extra week tags yet.';
      manualWeekList.appendChild(empty);
      manualWeeksBox.classList.add('empty');
    } else {
      manualWeeksBox.classList.remove('empty');
      Array.from(manualWeeks)
        .sort((a, b) => a - b)
        .forEach(weekNum => {
          const chip = document.createElement('div');
          chip.className = 'editor-manual-week-chip';
          const label = document.createElement('span');
          label.textContent = `Week ${weekNum}`;
          chip.appendChild(label);
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'icon-btn ghost';
          removeBtn.title = 'Remove week tag';
          removeBtn.setAttribute('aria-label', `Remove week ${weekNum}`);
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            manualWeeks.delete(weekNum);
            markDirty();
            renderManualWeekTags();
            scheduleRender({ weeks: true, lectures: true });
          });
          chip.appendChild(removeBtn);
          manualWeekList.appendChild(chip);
        });
    }
  }

  let activeBlockId = null;
  let activeWeekKey = null;

  function weekGroupsForBlock(block) {
    if (!block) return [];
    const weekNumbers = new Set();
    if (Number.isFinite(block.weeks)) {
      for (let i = 1; i <= block.weeks; i++) weekNumbers.add(i);
    }
    (block.lectures || []).forEach(l => {
      if (typeof l.week === 'number') weekNumbers.add(l.week);
    });
    const sortedWeeks = Array.from(weekNumbers).sort((a, b) => a - b);
    const groups = sortedWeeks.map(weekNumber => ({
      key: `${block.blockId}|${weekNumber}`,
      label: `Week ${weekNumber}`,
      lectures: (block.lectures || []).filter(l => l.week === weekNumber),
      weekNumber
    }));
    const unscheduledLectures = (block.lectures || []).filter(l => l.week == null || l.week === '');
    if (unscheduledLectures.length) {
      groups.push({
        key: `${block.blockId}|${UNSCHEDULED_KEY}`,
        label: 'Unscheduled',
        lectures: unscheduledLectures,
        unscheduled: true
      });
    }
    return groups;
  }

  function ensureActiveBlock() {
    if (activeBlockId && blockMap.has(activeBlockId)) return;
    for (const key of lectSet) {
      const [blockId] = key.split('|');
      if (blockId && blockMap.has(blockId)) {
        activeBlockId = blockId;
        return;
      }
    }
    for (const id of blockSet) {
      if (blockMap.has(id)) {
        activeBlockId = id;
        return;
      }
    }
    activeBlockId = blocks[0]?.blockId || null;
  }

  function ensureActiveWeek() {
    if (!activeBlockId || !blockMap.has(activeBlockId)) {
      activeWeekKey = null;
      return;
    }
    const block = blockMap.get(activeBlockId);
    const groups = weekGroupsForBlock(block);
    if (activeWeekKey && groups.some(group => group.key === activeWeekKey)) return;
    const selected = collectSelectedWeekKeys();
    for (const key of selected) {
      if (key.startsWith(`${activeBlockId}|`)) {
        activeWeekKey = key;
        return;
      }
    }
    activeWeekKey = groups.length ? groups[0].key : null;
  }

  function renderBlockChips() {
    blockChipRow.innerHTML = '';
    const taggedBlocks = Array.from(blockSet).filter(id => blockMap.has(id));
    if (!taggedBlocks.length) {
      const hint = document.createElement('div');
      hint.className = 'editor-tags-empty subtle';
      hint.textContent = 'Block tags update automatically as you choose lectures.';
      blockChipRow.appendChild(hint);
      return;
    }
    taggedBlocks.sort((a, b) => {
      const aTitle = blockMap.get(a)?.title || String(a);
      const bTitle = blockMap.get(b)?.title || String(b);
      return aTitle.localeCompare(bTitle);
    });
    taggedBlocks.forEach(blockId => {
      const title = blockMap.get(blockId)?.title || blockId;
      const chip = createTagChip(title, 'block', true);
      chip.addEventListener('click', () => {
        blockSet.delete(blockId);
        markDirty();
        scheduleRender({ chips: true, blocks: true, weeks: true, lectures: true });
      });
      blockChipRow.appendChild(chip);
    });
  }

  function renderBlockList() {
    blockListEl.innerHTML = '';
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty';
      empty.textContent = 'No curriculum blocks have been created yet.';
      blockListEl.appendChild(empty);
      return;
    }
    ensureActiveBlock();
    ensureActiveWeek();
    blocks.forEach(block => {
      if (!block) return;
      const blockId = block.blockId;
      const row = document.createElement('div');
      row.className = 'editor-block-row';
      if (blockHasSelectedLectures(blockId)) row.classList.add('has-lectures');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'editor-block-button';
      setToggleState(button, blockId === activeBlockId);

      const label = document.createElement('span');
      label.className = 'editor-block-label';
      label.textContent = block.title || blockId;
      button.appendChild(label);

      const count = lectureBlockCounts.get(String(blockId)) || 0;
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'editor-block-count';
        badge.textContent = `${count}`;
        badge.setAttribute('aria-label', `${count} selected lecture${count === 1 ? '' : 's'}`);
        button.appendChild(badge);
      }

      button.addEventListener('click', () => {
        activeBlockId = blockId;
        activeWeekKey = null;
        ensureActiveWeek();
        scheduleRender({ blocks: true, weeks: true, lectures: true });
      });

      row.appendChild(button);

      blockListEl.appendChild(row);
    });
  }

  function renderWeekList() {
    weekListEl.innerHTML = '';
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty subtle';
      empty.textContent = 'Add blocks to browse weeks.';
      weekListEl.appendChild(empty);
      return;
    }
    ensureActiveBlock();
    if (!activeBlockId || !blockMap.has(activeBlockId)) {
      const prompt = document.createElement('div');
      prompt.className = 'editor-tags-empty subtle';
      prompt.textContent = 'Select a block to view weeks.';
      weekListEl.appendChild(prompt);
      return;
    }
    const block = blockMap.get(activeBlockId);
    const groups = weekGroupsForBlock(block);
    ensureActiveWeek();
    const selectedWeekKeys = collectSelectedWeekKeys();
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty subtle';
      empty.textContent = 'Add weeks or lectures to this block to start tagging.';
      weekListEl.appendChild(empty);
      return;
    }
    groups.forEach(group => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'editor-week-button';
      setToggleState(btn, group.key === activeWeekKey);
      if (selectedWeekKeys.has(group.key)) btn.classList.add('has-selection');
      if (Number.isFinite(group.weekNumber) && manualWeeks.has(Number(group.weekNumber))) {
        btn.classList.add('manual');
      }
      const label = document.createElement('span');
      label.className = 'editor-week-label';
      label.textContent = group.label;
      btn.appendChild(label);
      const meta = document.createElement('span');
      meta.className = 'editor-week-meta';
      const total = group.lectures?.length || 0;
      if (total) {
        meta.textContent = `${total} lecture${total === 1 ? '' : 's'}`;
      } else if (group.unscheduled) {
        meta.textContent = 'No unscheduled lectures';
      } else {
        meta.textContent = 'No lectures yet';
      }
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        activeWeekKey = group.key;
        scheduleRender({ weeks: true, lectures: true });
      });
      weekListEl.appendChild(btn);
    });
  }

  function renderLectureList() {
    lectureListEl.innerHTML = '';
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty subtle';
      empty.textContent = 'Add blocks and lectures to start tagging.';
      lectureListEl.appendChild(empty);
      return;
    }
    ensureActiveBlock();
    ensureActiveWeek();
    if (!activeBlockId || !blockMap.has(activeBlockId)) {
      const prompt = document.createElement('div');
      prompt.className = 'editor-tags-empty subtle';
      prompt.textContent = 'Select a block to choose lectures.';
      lectureListEl.appendChild(prompt);
      return;
    }
    if (!activeWeekKey) {
      const prompt = document.createElement('div');
      prompt.className = 'editor-tags-empty subtle';
      prompt.textContent = 'Pick a week to see its lectures.';
      lectureListEl.appendChild(prompt);
      return;
    }
    const [blockId] = activeWeekKey.split('|');
    const block = blockMap.get(blockId);
    const groups = weekGroupsForBlock(block);
    const current = groups.find(group => group.key === activeWeekKey);
    if (!current) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty subtle';
      empty.textContent = 'No lectures available for this week yet.';
      lectureListEl.appendChild(empty);
      return;
    }
    if (!current.lectures.length) {
      const empty = document.createElement('div');
      empty.className = 'editor-tags-empty subtle';
      empty.textContent = current.unscheduled
        ? 'No unscheduled lectures yet.'
        : 'No lectures linked to this week yet.';
      lectureListEl.appendChild(empty);
      return;
    }
    current.lectures.forEach(lecture => {
      const key = `${blockId}|${lecture.id}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'editor-lecture-button';
      btn.textContent = lecture.name || `Lecture ${lecture.id}`;
      setToggleState(btn, lectSet.has(key));
      btn.addEventListener('click', () => {
        if (lectSet.has(key)) {
          lectSet.delete(key);
          decrementBlockCount(blockId);
        } else {
          lectSet.add(key);
          incrementBlockCount(blockId);
        }
        markDirty();
        scheduleRender({ chips: true, blocks: true, weeks: true, lectures: true });
      });
      lectureListEl.appendChild(btn);
    });
  }

  renderManualWeekTags();
  renderBlockChips();
  renderBlockList();
  renderWeekList();
  renderLectureList();

  form.appendChild(blockWrap);

  const actionBar = document.createElement('div');
  actionBar.className = 'editor-actions';

  status = document.createElement('span');
  status.className = 'editor-status';

  let saveBtn;
  let headerSaveBtn;

  async function persist(options = {}) {
    const opts = typeof options === 'boolean' ? { closeAfter: options } : options;
    const { closeAfter = false, silent = false } = opts;
    cancelAutoSave();
    const titleKey = kind === 'concept' ? 'concept' : 'name';
    const trimmed = nameInput.value.trim();
    if (!trimmed) {
      if (!silent) {
        status.textContent = 'Name is required.';
      }
      return false;
    }
    if (!silent && status) {
      status.classList.remove('editor-status-muted');
      status.textContent = 'Saving…';
    }
    const wasNew = !existing;
    const item = existing || { id: uid(), kind };
    item[titleKey] = trimmed;
    fieldMap[kind].forEach(([field]) => {
      const control = fieldInputs[field];
      const v = control?.getValue ? control.getValue() : '';
      item[field] = v;
    });
    item.extras = Array.from(extraControls.values()).map(({ id, titleInput, editor }) => ({
      id,
      title: titleInput.value.trim(),
      body: editor.getValue()
    })).filter(ex => ex.title || ex.body);
    item.facts = [];
    const blockTags = new Set(blockSet);
    lectSet.forEach(key => {
      const [blockId] = key.split('|');
      if (blockId) blockTags.add(blockId);
    });
    item.blocks = Array.from(blockTags);

    const weekNums = collectWeekNumbers();
    item.weeks = Array.from(weekNums).sort((a, b) => a - b);
    const lectures = [];
    for (const key of lectSet) {
      const [blockId, lecIdStr] = key.split('|');
      const lecId = Number(lecIdStr);
      const blk = blockMap.get(blockId);
      const l = blk?.lectures.find(le => le.id === lecId);
      if (l) lectures.push({ blockId, id: l.id, name: l.name, week: l.week });
    }
    item.lectures = lectures;
    item.color = colorInput.value;
    const signature = computePersistSignature(item);
    const canCompareSignature = signature && lastPersistSignature && existing && existing.id === item.id;
    const shouldSkipPersist = Boolean(canCompareSignature && signature === lastPersistSignature);
    try {
      if (!shouldSkipPersist) {
        await upsertItem(item);
      }
    } catch (err) {
      console.error(err);
      if (status) {
        if (statusFadeTimer) {
          clearTimeout(statusFadeTimer);
          statusFadeTimer = null;
        }
        status.classList.remove('editor-status-muted');
        status.textContent = silent ? 'Autosave failed' : 'Failed to save.';
      }
      throw err;
    }
    existing = item;
    lastPersistSignature = signature;
    updateTitle();
    isDirty = false;
    const shouldNotify = onSave && (!silent || wasNew);
    if (shouldNotify) onSave();
    if (closeAfter) {
      win.close('saved');
    } else {
      if (statusFadeTimer) {
        clearTimeout(statusFadeTimer);
        statusFadeTimer = null;
      }
      if (status) {
        if (silent) {
          status.textContent = 'Autosaved';
          status.classList.add('editor-status-muted');
          statusFadeTimer = setTimeout(() => {
            status.classList.remove('editor-status-muted');
            statusFadeTimer = null;
          }, 1800);
        } else {
          status.textContent = shouldSkipPersist ? 'Up to date' : 'Saved';
          status.classList.remove('editor-status-muted');
        }
      }
    }
    return true;
  }

  function handleSaveRequest() {
    if (headerSaveBtn) headerSaveBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    persist({ closeAfter: true })
      .catch(() => {})
      .finally(() => {
        if (headerSaveBtn) headerSaveBtn.disabled = false;
        if (saveBtn) saveBtn.disabled = false;
      });
  }

  headerSaveBtn = win.addAction({
    text: '✓',
    ariaLabel: 'Save entry',
    title: 'Save and close',
    className: 'floating-action--confirm',
    onClick: handleSaveRequest
  });

  saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save & Close';
  saveBtn.addEventListener('click', handleSaveRequest);

  actionBar.appendChild(saveBtn);
  actionBar.appendChild(status);
  form.appendChild(actionBar);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveRequest();
  });

  win.setContent(form);

  const updateTitle = () => {
    const base = `${existing ? 'Edit' : 'Add'} ${titleMap[kind] || kind}`;
    const name = nameInput.value.trim();
    if (name) {
      win.setTitle(`${base}: ${name}`);
    } else {
      win.setTitle(base);
    }
  };
  nameInput.addEventListener('input', updateTitle);
  updateTitle();

  win.focus();
  nameInput.focus();
}