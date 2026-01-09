export function createAppShell({
  state,
  setTab,
  setSubtab,
  setQuery,
  setListQuery,
  setFilters,
  setListFilters,
  listAllItems,
  repairItemKinds,
  filterItemsLocally,
  findItemsByFilter,
  renderSettings,
  renderCardList,
  renderCards,
  renderBuilder,
  renderLectures,
  renderFlashcards,
  renderReview,
  renderQuiz,
  renderBlockMode,
  renderBlockBoard,
  renderExams,
  renderQBank,
  renderExamRunner,
  createEntryAddControl
}) {
  const tabs = ["Block Board","Lists","Cards","Study","Exams","Lectures"];

  const listTabConfig = [
    { label: 'Diseases', kind: 'disease' },
    { label: 'Drugs', kind: 'drug' },
    { label: 'Concepts', kind: 'concept' }
  ];

  function resolveListKind() {
    const active = state?.subtab?.Lists;
    const match = listTabConfig.find(cfg => cfg.label === active);
    return match ? match.kind : 'disease';
  }

  let shell = null;
  let tabButtons = new Map();
  let searchInput = null;
  let settingsBtn = null;
  let main = null;
  let pendingQuery = '';
  let pendingQueryTab = '';
  let queryUpdateTimer = 0;
  const tabScrollState = new Map();
  let listRepairAttempted = false;

  async function loadListItems(filter) {
    let items = [];
    if (!listRepairAttempted && typeof repairItemKinds === 'function') {
      listRepairAttempted = true;
      try {
        await repairItemKinds();
      } catch (err) {
        console.warn('Failed to repair list items', err);
      }
    }
    if (typeof listAllItems === 'function' && typeof filterItemsLocally === 'function') {
      try {
        const allItems = await listAllItems();
        items = await filterItemsLocally(allItems, filter);
      } catch (err) {
        console.warn('List query failed, falling back to indexed query', err);
      }
    }
    if (!items.length) {
      try {
        items = await findItemsByFilter(filter).toArray();
      } catch (err) {
        console.warn('List query failed', err);
      }
    }
    return items;
  }

  function buildScrollKey() {
    const activeTab = state.tab || '';
    const subtab = state.subtab?.[activeTab] || '';
    if (activeTab === 'Study') {
      const mode = state.flashSession
        ? 'flash'
        : state.quizSession
          ? 'quiz'
          : (subtab || 'builder');
      return `${activeTab}:${mode}`;
    }
    if (activeTab === 'Exams') {
      if (state.examSession) return `${activeTab}:session`;
      return `${activeTab}:${subtab || 'list'}`;
    }
    return subtab ? `${activeTab}:${subtab}` : activeTab;
  }

  function captureTabScroll() {
    if (!main) return;
    const content = main.querySelector('.tab-content');
    if (!content) return;
    tabScrollState.set(buildScrollKey(), {
      top: content.scrollTop,
      left: content.scrollLeft
    });
  }

  function restoreTabScroll(content) {
    if (!content) return;
    const snapshot = tabScrollState.get(buildScrollKey());
    if (!snapshot) return;
    if (typeof content.scrollTo === 'function') {
      content.scrollTo({ top: snapshot.top, left: snapshot.left, behavior: 'auto' });
    } else {
      content.scrollTop = snapshot.top;
      content.scrollLeft = snapshot.left;
    }
  }

  function scheduleTabScrollRestore(content) {
    if (!content) return;
    restoreTabScroll(content);
    let attempts = 0;
    const maxAttempts = 4;
    const retry = () => {
      attempts += 1;
      if (attempts > maxAttempts) return;
      restoreTabScroll(content);
      const delay = 80 * attempts;
      setTimeout(() => requestAnimationFrame(retry), delay);
    };
    requestAnimationFrame(retry);
  }

  function ensureShell() {
    if (shell) return shell;
    const root = document.getElementById('app');
    if (!root) {
      throw new Error('Missing app root');
    }
    root.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'header';

    const left = document.createElement('div');
    left.className = 'header-left';
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = `
      <svg class="brand-icon" viewBox="0 0 80 80" aria-hidden="true" focusable="false">
        <defs>
          <path id="brand-arc-path" d="M10 46 A30 30 0 0 1 70 46" />
        </defs>
        <circle cx="40" cy="40" r="24" fill="#ffffff" />
        <text class="brand-icon-text">
          <textPath href="#brand-arc-path" startOffset="50%" text-anchor="middle">ARC</textPath>
        </text>
      </svg>
      <span class="sr-only">Arc</span>
    `;
    left.appendChild(brand);

    const nav = document.createElement('nav');
    nav.className = 'tabs';
    nav.setAttribute('aria-label', 'Primary sections');
    const tabClassMap = {
      'Block Board': 'tab-block-board',
      Lists: 'tab-lists',
      Lectures: 'tab-lectures',
      Cards: 'tab-cards',
      Study: 'tab-study',
      Exams: 'tab-exams'
    };
    tabButtons = new Map();
    tabs.forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      const variant = tabClassMap[t];
      if (variant) btn.classList.add(variant);
      btn.textContent = t;
      btn.addEventListener('click', () => {
        const wasActive = state.tab === t;
        let needsRender = false;
        if (t === 'Study' && wasActive && state.subtab?.Study === 'Review' && !state.flashSession && !state.quizSession) {
          needsRender = setSubtab('Study', 'Builder') || needsRender;
        }
        const tabChanged = setTab(t);
        if (tabChanged || needsRender) {
          renderApp();
        }
      });
      tabButtons.set(t, btn);
      nav.appendChild(btn);
    });
    left.appendChild(nav);
    header.appendChild(left);

    const right = document.createElement('div');
    right.className = 'header-right';

    const searchField = document.createElement('label');
    searchField.className = 'search-field';
    searchField.setAttribute('aria-label', 'Search entries');

    const searchIcon = document.createElement('span');
    searchIcon.className = 'search-icon';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 14.5L18 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9" cy="9" r="5.8" stroke="currentColor" stroke-width="1.6"/></svg>';
    searchField.appendChild(searchIcon);

    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search entries';
    searchInput.value = state.tab === 'Lists' ? state.listQuery : state.query;
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.className = 'search-input';
    searchInput.dataset.role = 'global-search';
    pendingQuery = searchInput.value;
    pendingQueryTab = state.tab;
    const commitQuery = (value, tabContext = state.tab) => {
      const next = typeof value === 'string' ? value : '';
      const didUpdate = tabContext === 'Lists'
        ? (typeof setListQuery === 'function' && setListQuery(next))
        : setQuery(next);
      if (didUpdate) {
        renderApp();
      }
    };
    const scheduleQueryUpdate = (value, tabContext) => {
      pendingQuery = typeof value === 'string' ? value : '';
      pendingQueryTab = tabContext;
      if (queryUpdateTimer) {
        clearTimeout(queryUpdateTimer);
      }
      queryUpdateTimer = setTimeout(() => {
        queryUpdateTimer = 0;
        commitQuery(pendingQuery, pendingQueryTab);
      }, 120);
    };
    searchInput.addEventListener('input', e => {
      scheduleQueryUpdate(e.target.value, state.tab);
    });
    searchInput.addEventListener('search', e => {
      pendingQuery = typeof e.target.value === 'string' ? e.target.value : '';
      pendingQueryTab = state.tab;
      if (queryUpdateTimer) {
        clearTimeout(queryUpdateTimer);
        queryUpdateTimer = 0;
      }
      commitQuery(pendingQuery, pendingQueryTab);
    });
    searchField.appendChild(searchInput);
    right.appendChild(searchField);

    settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'header-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.582.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6"/></svg>';
    settingsBtn.addEventListener('click', () => {
      if (setTab('Settings')) {
        renderApp();
      }
    });
    right.appendChild(settingsBtn);

    header.appendChild(right);
    root.appendChild(header);

    main = document.createElement('main');
    root.appendChild(main);

    shell = { root, header, main };
    return shell;
  }

  async function renderApp() {
    if (typeof document !== 'undefined') {
      document.body.classList.remove('is-deck-open');
      document.body.classList.remove('is-occlusion-workspace-open');
    }
    ensureShell();
    const previousNodes = Array.from(main.childNodes);
    const activeEl = document.activeElement;
    const shouldRestoreSearch = activeEl && activeEl.dataset && activeEl.dataset.role === 'global-search';
    const selectionStart = shouldRestoreSearch && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
    const selectionEnd = shouldRestoreSearch && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

    try {
      tabButtons.forEach((btn, tab) => {
        btn.classList.toggle('active', state.tab === tab);
      });
      if (settingsBtn) {
        settingsBtn.classList.toggle('active', state.tab === 'Settings');
      }
      const activeQueryValue = state.tab === 'Lists' ? state.listQuery : state.query;
      if (searchInput && document.activeElement !== searchInput && searchInput.value !== activeQueryValue) {
        searchInput.value = activeQueryValue;
      }

      if (shouldRestoreSearch && searchInput) {
        requestAnimationFrame(() => {
          searchInput.focus();
          if (selectionStart !== null && selectionEnd !== null && searchInput.setSelectionRange) {
            searchInput.setSelectionRange(selectionStart, selectionEnd);
          } else {
            const len = searchInput.value.length;
            if (searchInput.setSelectionRange) searchInput.setSelectionRange(len, len);
          }
        });
      }

      captureTabScroll();
      main.innerHTML = '';


      if (state.tab === 'Settings') {
        await renderSettings(main);
      } else if (state.tab === 'Lists') {
        const kind = resolveListKind();
        const listMeta = listTabConfig.find(cfg => cfg.kind === kind) || listTabConfig[0];
        const createTarget = listMeta?.kind || 'disease';

        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);

        const entryControlPromise = Promise.resolve(createEntryAddControl(renderApp, createTarget))
          .then(control => {
            if (control) {
              main.insertBefore(control, content);
            }
          })
          .catch(err => {
            console.warn('Failed to create list entry control', err);
          });

        const selector = document.createElement('div');
        selector.className = 'list-subtabs';
        selector.setAttribute('role', 'tablist');
        listTabConfig.forEach(cfg => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'list-subtab';
          btn.textContent = cfg.label;
          btn.dataset.listKind = cfg.kind;
          btn.setAttribute('role', 'tab');
          if (cfg.kind === kind) btn.classList.add('active');
          btn.addEventListener('click', () => {
            if (setSubtab('Lists', cfg.label)) {
              renderApp();
            }
          });
          selector.appendChild(btn);
        });
        const countBadge = document.createElement('span');
        countBadge.className = 'list-count-badge';
        countBadge.setAttribute('aria-live', 'polite');
        selector.appendChild(countBadge);
        content.appendChild(selector);

        const listHost = document.createElement('div');
        listHost.className = 'list-host';
        content.appendChild(listHost);

        const listFilters = state.listFilters || {};
        const filter = { ...listFilters, types: [kind], query: state.listQuery };
        let items = await loadListItems(filter);
        const hasActiveFilters = Boolean(
          state.listQuery || listFilters.block || listFilters.week || listFilters.onlyFav
        );
        if (!items.length && hasActiveFilters) {
          const fallbackFilter = {
            ...listFilters,
            types: [kind],
            block: '',
            week: '',
            onlyFav: false,
            query: ''
          };
          const fallbackItems = await loadListItems(fallbackFilter);
          if (fallbackItems.length) {
            if (typeof setListFilters === 'function') {
              setListFilters({ block: '', week: '', onlyFav: false });
            }
            if (state.listQuery && typeof setListQuery === 'function') setListQuery('');
            items = fallbackItems;
          }
        }
        const summary = document.createElement('div');
        summary.className = 'list-summary';
        const count = document.createElement('div');
        count.className = 'list-summary-count';
        count.textContent = `${items.length} ${listMeta.label.toLowerCase()} entr${items.length === 1 ? 'y' : 'ies'}`;
        summary.appendChild(count);
        const chips = document.createElement('div');
        chips.className = 'list-summary-chips';
        const addChip = (label) => {
          const chip = document.createElement('span');
          chip.className = 'list-summary-chip';
          chip.textContent = label;
          chips.appendChild(chip);
        };
        if (state.listQuery) addChip(`Search: ${state.listQuery}`);
        if (listFilters.block) addChip(`Block: ${listFilters.block}`);
        if (listFilters.week) addChip(`Week: ${listFilters.week}`);
        if (listFilters.onlyFav) addChip('Favorites only');
        if (chips.childElementCount) {
          summary.appendChild(chips);
        }
        const actions = document.createElement('div');
        actions.className = 'list-summary-actions';
        if (hasActiveFilters) {
          const clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'btn secondary';
          clearBtn.textContent = 'Clear list filters';
          clearBtn.addEventListener('click', () => {
            setListFilters({ block: '', week: '', onlyFav: false });
            if (state.listQuery) setListQuery('');
            renderApp();
          });
          actions.appendChild(clearBtn);
        }
        summary.appendChild(actions);
        content.insertBefore(summary, listHost);
        const renderPromise = renderCardList(listHost, items, kind, renderApp);
        await Promise.all([entryControlPromise, renderPromise]);
        scheduleTabScrollRestore(content);
      } else if (state.tab === 'Block Board') {
        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);
        const entryControlPromise = Promise.resolve(createEntryAddControl(renderApp, 'disease'))
          .then(control => {
            if (control) {
              main.insertBefore(control, content);
            }
          })
          .catch(err => {
            console.warn('Failed to create block board entry control', err);
          });
        const renderPromise = renderBlockBoard(content, renderApp);
        await Promise.all([entryControlPromise, renderPromise]);
        restoreTabScroll(content);
      } else if (state.tab === 'Lectures') {
        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);
        await renderLectures(content, renderApp);
        restoreTabScroll(content);
      } else if (state.tab === 'Cards') {
        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);
        const filter = { types: state.filters?.types, sort: state.filters?.sort, query: state.query };
        const query = findItemsByFilter(filter);
        const entryControlPromise = Promise.resolve(createEntryAddControl(renderApp, 'disease'))
          .then(control => {
            if (control) {
              main.insertBefore(control, content);
            }
          })
          .catch(err => {
            console.warn('Failed to create cards entry control', err);
          });
        const itemsPromise = query.toArray();
        const cardsPromise = itemsPromise.then(items => renderCards(content, items, renderApp));
        await Promise.all([entryControlPromise, cardsPromise]);
        scheduleTabScrollRestore(content);
      } else if (state.tab === 'Study') {
        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);
        const entryControlPromise = Promise.resolve(createEntryAddControl(renderApp, 'disease'))
          .then(control => {
            if (control) {
              main.insertBefore(control, content);
            }
          })
          .catch(err => {
            console.warn('Failed to create study entry control', err);
          });
        if (state.flashSession) {
          await Promise.all([
            entryControlPromise,
            renderFlashcards(content, renderApp)
          ]);
        } else if (state.quizSession) {
          await Promise.all([
            entryControlPromise,
            renderQuiz(content, renderApp)
          ]);
        } else {
          const activeStudy = state.subtab.Study === 'Blocks' ? 'Blocks' : (state.subtab.Study || 'Builder');
          if (activeStudy === 'Review') {
            await Promise.all([
              entryControlPromise,
              renderReview(content, renderApp)
            ]);
          } else if (activeStudy === 'Blocks') {
            await Promise.all([
              entryControlPromise,
              renderBlockMode(content, renderApp)
            ]);
          } else {
            const wrap = document.createElement('div');
            const builderPromise = renderBuilder(wrap, renderApp).then(() => {
              content.appendChild(wrap);
            });
            await Promise.all([entryControlPromise, builderPromise]);
          }
        }
        restoreTabScroll(content);
      } else if (state.tab === 'Exams') {
        const content = document.createElement('div');
        content.className = 'tab-content';
        main.appendChild(content);
        const entryControlPromise = Promise.resolve(createEntryAddControl(renderApp, 'disease'))
          .then(control => {
            if (control) {
              main.insertBefore(control, content);
            }
          })
          .catch(err => {
            console.warn('Failed to create exams entry control', err);
          });
        if (state.examSession) {
          await Promise.all([
            entryControlPromise,
            renderExamRunner(content, renderApp)
          ]);
        } else if (state.subtab?.Exams === 'QBank') {
          await Promise.all([
            entryControlPromise,
            renderQBank(content, renderApp)
          ]);
        } else {
          await Promise.all([
            entryControlPromise,
            renderExams(content, renderApp)
          ]);
        }
        restoreTabScroll(content);
      } else {
        main.textContent = `Currently viewing: ${state.tab}`;
      }
    } catch (err) {
      console.error('Failed to render app', err);
      if (main) {
        main.innerHTML = '';
        if (previousNodes.length) {
          previousNodes.forEach(node => main.appendChild(node));
        } else {
          const fallback = document.createElement('div');
          fallback.className = 'tab-content';
          fallback.textContent = 'Something went wrong while rendering this view.';
          main.appendChild(fallback);
        }
      }
    }
  }

  return { renderApp, tabs, resolveListKind };
}
