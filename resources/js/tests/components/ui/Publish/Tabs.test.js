import { mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import { defineComponent, h, nextTick, onMounted } from 'vue';
import * as Globals from '@/bootstrap/globals';
import Container from '@/components/ui/Publish/Container.vue';
import Tabs from '@/components/ui/Publish/Tabs.vue';
import useDirtyState from '@/composables/dirty-state.js';

// The dirty state composable listens to Inertia's router.
vi.mock('@inertiajs/vue3', () => ({ router: { on: () => () => {}, visit: vi.fn() } }));

window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

vi.mock('@/components/ElementContainer.vue', () => ({
    default: defineComponent({
        emits: ['resized'],
        setup(props, { emit, slots }) {
            onMounted(() => emit('resized', { width: 1000 }));
            return () => h('div', slots.default?.());
        },
    }),
}));

// The fields themselves are irrelevant here.
vi.mock('@/components/ui/Publish/Sections.vue', () => ({ default: defineComponent({ render: () => h('div') }) }));

Object.keys(Globals).forEach((fn) => (window[fn] = Globals[fn]));

window.Statamic = {
    $config: {
        get: (key) => (key === 'sites' ? [{ handle: 'default', direction: 'ltr' }] : undefined),
    },
    $dirty: { has: () => false, add: () => {}, remove: () => {} },
    $events: { $emit: () => {} },
    $preferences: { get: () => true },
};

const { add, remove } = useDirtyState();

function makeTab(handle) {
    const field = { handle: `${handle}_field`, type: 'text', display: handle, config: { type: 'text' } };

    return { handle, display: handle, sections: [{ fields: [field] }] };
}

let wrapper;
let listeners = [];

async function mountTabs(url, { rememberTab = true } = {}) {
    window.history.replaceState({ page: {} }, '', url);

    wrapper = mount(Container, {
        attachTo: document.body,
        props: {
            blueprint: { tabs: [makeTab('main'), makeTab('contact')] },
            site: 'default',
            rememberTab,
            modelValue: { main_field: '', contact_field: '' },
        },
        slots: { default: () => h(Tabs) },
    });

    await nextTick();
}

function activeTab() {
    return wrapper.find('[role="tab"][aria-selected="true"]').text();
}

// Let any queued popstate/hashchange events run.
async function settle() {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
}

// Reka's tab triggers activate on mousedown.
async function clickTab(name) {
    const trigger = wrapper.findAll('[role="tab"]').find((el) => el.text().includes(name));
    await trigger.trigger('mousedown');
    await trigger.trigger('click');
    await settle();
}

// jsdom traverses history asynchronously.
async function traverse(delta) {
    const url = window.location.href;
    window.history.go(delta);
    await vi.waitFor(() => expect(window.location.href).not.toBe(url));
    await settle();
}

// Runs after the dirty state listener, like Inertia's.
function listenToPopstate(listener = vi.fn()) {
    listeners.push(listener);
    window.addEventListener('popstate', listener);

    return listener;
}

// Mimics Inertia's handler for a popstate without state, which restores the URL of the page it loaded
// (handlePopstateEvent in @inertiajs/core).
function restoreInertiaUrl(url) {
    return (event) => {
        if (!event.state) window.history.replaceState({ page: {} }, '', url + window.location.hash);
    };
}

afterEach(() => {
    listeners.forEach((listener) => window.removeEventListener('popstate', listener));
    listeners = [];
    remove('entry');
    vi.restoreAllMocks();
    delete window.navigation;
    wrapper?.unmount();
    wrapper = null;
});

// Opening /entries/2#contact shows the Contact tab.
test('a tab in the URL hash is active on mount, so links to a tab still work', async () => {
    await mountTabs('/cp/collections/events/entries/2#contact');

    expect(activeTab()).toBe('contact');
});

// Opening /entries/2#nope shows the first tab.
test('an unknown tab in the URL hash falls back to the first tab', async () => {
    await mountTabs('/cp/collections/events/entries/2#nope');

    expect(activeTab()).toBe('main');
});

// The "Skip to sidebar" link goes to #main, which is also the name of the Main tab.
test('a link to an anchor named like a tab does not switch tabs', async () => {
    window.navigation = new EventTarget();
    await mountTabs('/cp/collections/events/entries/2');
    await clickTab('contact');

    window.navigation.dispatchEvent(Object.assign(new Event('navigate'), { navigationType: 'push' }));
    window.location.hash = 'main';
    await settle();

    expect(activeTab()).toBe('contact');
});

// Inline forms (e.g. editing in a stack) don't touch the page URL.
test('the URL is left alone when the tab is not remembered', async () => {
    await mountTabs('/cp/collections/events/entries/2', { rememberTab: false });

    await clickTab('contact');

    expect(activeTab()).toBe('contact');
    expect(window.location.hash).toBe('');
});

// Clicking a tab must not fire popstate. That's what let Inertia restore the wrong URL.
test('changing tabs updates the hash without navigating, so no popstate fires', async () => {
    const popstate = listenToPopstate();
    await mountTabs('/cp/collections/events/entries/2');

    await clickTab('contact');

    expect(window.location.pathname).toBe('/cp/collections/events/entries/2');
    expect(window.location.hash).toBe('#contact');
    expect(popstate).not.toHaveBeenCalled();
});

// Inertia keeps its page data in the history state, so it must not be lost.
test('changing tabs keeps the current history state', async () => {
    await mountTabs('/cp/collections/events/entries/2');
    const state = window.history.state;

    await clickTab('contact');

    expect(window.history.state).toEqual(state);
});

// Each tab click can be undone with Back. Opening a link to a tab adds nothing.
test('changing tabs adds a history entry, but loading a tab from the hash does not', async () => {
    const length = window.history.length;
    await mountTabs('/cp/collections/events/entries/2#contact');
    await settle();

    expect(window.history.length).toBe(length);

    await clickTab('main');

    expect(window.history.length).toBe(length + 1);
});

// The reported bug: edit after switching site, click tabs, no prompt.
test('changing tabs after switching localization does not warn about unsaved changes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await mountTabs('/cp/collections/events/entries/1');
    listenToPopstate(restoreInertiaUrl('/cp/collections/events/entries/1'));

    // Switching site changes the URL without telling Inertia.
    window.history.replaceState({}, '', '/cp/collections/events/entries/2');
    add('entry');

    await clickTab('contact');
    await clickTab('main');
    await clickTab('contact');

    expect(confirm).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/cp/collections/events/entries/2');
    expect(window.location.hash).toBe('#contact');
});

// Back/Forward moves between tabs, and Back past the first click shows the first tab.
test('back and forward switch between the tabs', async () => {
    const inertia = listenToPopstate();
    await mountTabs('/cp/collections/events/entries/2');

    await clickTab('contact');

    await traverse(-1);
    expect(activeTab()).toBe('main');

    await traverse(1);
    expect(activeTab()).toBe('contact');

    // jsdom has no Navigation API, so like older browsers this falls through to Inertia.
    expect(inertia).toHaveBeenCalledTimes(2);
});

// Same as above with unsaved changes: they're kept and there's no prompt.
test('back and forward keep unsaved changes without warning', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const inertia = listenToPopstate();
    await mountTabs('/cp/collections/events/entries/2');
    add('entry');

    await clickTab('contact');
    await clickTab('main');
    await clickTab('contact');

    await traverse(-1);
    expect(activeTab()).toBe('main');
    expect(window.location.hash).toBe('#main');

    await traverse(-1);
    expect(activeTab()).toBe('contact');

    await traverse(-1);
    expect(activeTab()).toBe('main');
    expect(window.location.hash).toBe('');

    await traverse(1);
    expect(activeTab()).toBe('contact');

    expect(inertia).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
});
