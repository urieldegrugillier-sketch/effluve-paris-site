/* Effluve Paris — admin.html's own script. Self-contained (doesn't load
   js/account.js) -- this page needs a narrow slice of Supabase Auth (get the
   current session, sign out) plus its own admin-only queries, not
   js/account.js's whole customer-account surface (mocked card fields,
   guest-checkout GUEST_KEY, password reset, etc., none of which apply here).

   AUTH: the check below (real session + profiles.is_admin === true) is only
   ever a UX convenience -- it decides whether this tab SHOWS the admin UI,
   nothing more. Two real server-side boundaries back it up: RLS on
   public.orders (see supabase/migrations/20260806000000_admin_shipping.sql)
   for reads, and supabase/functions/mark-order-shipped's own is_admin check
   for the one write this page performs (routed through that function, not a
   direct .update(), specifically so the Resend API key it needs never has
   to reach this file -- see that function's own top comment). Never assume
   this file is the only thing standing between a non-admin and the data. */
(function () {
  function client() { return window.MonarkSupabase; }

  const authGate = document.getElementById('admin-auth-gate');
  const app = document.getElementById('admin-app');
  const whoamiEl = document.getElementById('admin-whoami');

  // Item 7 (post-login redirect): admin.html passes its own URL along so
  // account.html knows where to send an admin back after they log in --
  // see account.html's own inline script for the other half of this (which
  // re-verifies is_admin server-side before ever honoring it, so this query
  // param can't be used to bounce a non-admin anywhere it shouldn't go).
  function redirectToLogin() {
    window.location.href = 'account.html?redirect=admin.html';
  }

  async function checkAccessAndInit() {
    if (!client() || !client().auth) {
      authGate.textContent = 'Erreur de configuration -- réessayez plus tard.';
      return;
    }

    // getSession() (not a synchronous cache like js/account.js's own
    // getSession() -- see that file's own comment on why IT can get away
    // with a cache) -- this is a security gate, so it needs the real,
    // resolved answer, not an optimistic value that might flip a moment
    // later.
    const { data: { session } } = await client().auth.getSession();
    if (!session) {
      redirectToLogin();
      return;
    }

    const { data: profile, error } = await client()
      .from('profiles')
      .select('is_admin, first_name, last_name')
      .eq('id', session.user.id)
      .single();

    if (error || !profile || profile.is_admin !== true) {
      redirectToLogin();
      return;
    }

    authGate.hidden = true;
    app.hidden = false;
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
    whoamiEl.textContent = name ? `${name} (${session.user.email})` : session.user.email;

    initTabs();
    initLogout();
    initOrders();
    initPromoCodes();
    initPromoRemainingConfig();
    initTimerConfig();
    initStock();
  }

  // ---------------- Tabs (generic -- see admin.html's own comment) ----------------
  // Same "remember across a refresh, this browser only" localStorage
  // convention as js/i18n.js's own language persistence / js/cart.js's own
  // cart contents -- monark_ prefix kept (not effluve_) to match every
  // other storage key in this codebase, none of which were renamed at the
  // Effluve Paris rebrand either.
  const ACTIVE_TAB_STORAGE_KEY = 'monark_admin_active_tab';

  function initTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    const panels = document.querySelectorAll('.admin-panel');

    function activateTab(target) {
      tabs.forEach((t) => t.classList.toggle('active', t.getAttribute('data-tab') === target));
      panels.forEach((panel) => {
        panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === target);
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');
        activateTab(target);
        localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, target);
      });
    });

    // Restores whichever tab was open before a refresh -- admin.html's own
    // hardcoded .admin-tab.active/.admin-panel.active (Commandes/orders) is
    // just the very-first-visit default; a stored value overrides it here.
    // Validated against the tabs that actually exist (Array.find, not a CSS
    // attribute selector built from this value) before applying -- a stale
    // value from a previous build/removed tab, or manual localStorage
    // editing, just falls back to that HTML default instead of landing on
    // no active tab/panel at all.
    const storedTab = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    const storedTabExists = Array.from(tabs).some((t) => t.getAttribute('data-tab') === storedTab);
    if (storedTab && storedTabExists) activateTab(storedTab);
  }

  function initLogout() {
    document.getElementById('admin-logout').addEventListener('click', async () => {
      await client().auth.signOut();
      redirectToLogin();
    });
  }

  // ---------------- Orders tab ----------------
  let ordersCache = []; // last successful fetch, re-rendered on filter toggle without a refetch
  let profileNameById = {}; // user_id -> "First Last" (or "" if never set)
  let profileEmailById = {}; // user_id -> auth email (public.profiles.email, synced via trigger -- see supabase/migrations/20260822000000_add_profiles_email_sync.sql)

  const loadingEl = document.getElementById('admin-orders-loading');
  const errorEl = document.getElementById('admin-orders-error');
  const emptyEl = document.getElementById('admin-orders-empty');
  const tableEl = document.getElementById('admin-orders-table');
  const tbodyEl = document.getElementById('admin-orders-tbody');
  const filterPendingEl = document.getElementById('admin-filter-pending');

  function initOrders() {
    filterPendingEl.addEventListener('change', () => renderOrders());
    loadOrders();
  }

  async function loadOrders() {
    loadingEl.hidden = false;
    errorEl.hidden = true;
    emptyEl.hidden = true;
    tableEl.hidden = true;

    // status = 'paid' only -- an order still 'processing' (webhook hasn't
    // reconciled it yet, see supabase/functions/stripe-webhook's own
    // comment) was never actually confirmed as paid, so there's nothing to
    // ship yet regardless of what shipping_status defaults to.
    const { data: orders, error: ordersError } = await client()
      .from('orders')
      .select('id, reference_number, user_id, guest_email, product_name, quantity, total, created_at, shipping_status, tracking_number, carrier, shipping_name, shipping_address_line1, shipping_address_line2, shipping_city, shipping_postal_code, shipping_country')
      .eq('status', 'paid')
      .order('created_at', { ascending: false });

    if (ordersError) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = `Erreur lors du chargement des commandes : ${ordersError.message}`;
      console.error('admin.js loadOrders:', ordersError.message);
      return;
    }

    // Two separate queries (orders, then profiles for the user_ids present)
    // rather than a PostgREST embed -- orders.user_id's own foreign key
    // points at auth.users, not public.profiles (no direct FK PostgREST
    // could auto-detect a relationship from), so a manual client-side join
    // is the straightforward option here.
    const userIds = Array.from(new Set(orders.filter((o) => o.user_id).map((o) => o.user_id)));
    profileNameById = {};
    profileEmailById = {};
    if (userIds.length) {
      const { data: profiles, error: profilesError } = await client()
        .from('profiles')
        .select('id, first_name, last_name, email')
        .in('id', userIds);
      if (profilesError) {
        console.error('admin.js loadOrders (profiles):', profilesError.message);
        // Not fatal -- orders still render, just with a blank customer name/
        // email for whichever rows needed a profile lookup that failed.
      } else {
        profiles.forEach((p) => {
          profileNameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(' ');
          profileEmailById[p.id] = p.email || '';
        });
      }
    }

    ordersCache = orders;
    loadingEl.hidden = true;
    renderOrders();
  }

  // Name column -- prefers the real account's own profile name (the
  // canonical, editable-via-Edit-Profile identity) when there is one, same
  // as this used to be the only source shown here. Falls back to
  // shipping_name (this specific order's own captured name -- see
  // formatShippingAddress()'s own comment on where that column comes from)
  // for a guest order (no profile at all to read) or an account with no
  // name ever set on its profile, rather than leaving either blank the way
  // this column used to for a guest.
  function customerName(order) {
    if (order.user_id) return profileNameById[order.user_id] || order.shipping_name || '—';
    return order.shipping_name || '—';
  }

  // Email column -- public.profiles.email for a real account (synced from
  // auth.users via trigger, see supabase/migrations/20260822000000_add_
  // profiles_email_sync.sql), guest_email for a guest order. Previously
  // there was no separate email column at all -- an account order showed
  // only its name, a guest order only its email, never both together.
  function customerEmail(order) {
    if (order.user_id) return profileEmailById[order.user_id] || '—';
    return order.guest_email || '—';
  }

  // DD/MM/YYYY HH:MM, always -- toLocaleDateString's own output shape isn't
  // guaranteed stable across browsers/locales even when passed the same
  // options, and this is an internal tool where a single unambiguous format
  // matters more than any locale-awareness.
  function formatDate(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatMoney(n) {
    return '€' + Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Item 4: Product column truncated by default (CSS text-overflow:ellipsis
  // on .admin-product-truncated, see css/admin.css), click toggles a class
  // that removes the truncation and lets it wrap in place -- simplest
  // interaction that works identically with mouse or touch, no separate
  // tooltip/popover component needed for what's genuinely a one-off internal
  // tool.
  function productCellHtml(order) {
    const full = escapeHtml(`${order.product_name} × ${order.quantity} (${formatMoney(order.total)})`);
    return `<span class="admin-product-truncated" title="Cliquer pour afficher en entier">${full}</span>`;
  }

  function renderOrders() {
    const showPendingOnly = filterPendingEl.checked;
    const rows = showPendingOnly
      ? ordersCache.filter((o) => o.shipping_status !== 'shipped')
      : ordersCache;

    if (!rows.length) {
      tableEl.hidden = true;
      emptyEl.hidden = false;
      tbodyEl.innerHTML = '';
      return;
    }

    emptyEl.hidden = true;
    tableEl.hidden = false;
    tbodyEl.innerHTML = rows.map((order) => {
      const shipped = order.shipping_status === 'shipped';
      const nameCell = `<td data-label="Nom">${escapeHtml(customerName(order))}</td>`;
      const emailCell = `<td data-label="Email">${escapeHtml(customerEmail(order))}</td>`;
      const commonCells = `
          <td data-label="Référence">${escapeHtml(order.reference_number || '—')}</td>
          ${nameCell}
          ${emailCell}
          <td data-label="Produit">${productCellHtml(order)}</td>
          <td data-label="Date">${formatDate(order.created_at)}</td>
          <td data-label="Statut"><span class="admin-status-pill ${shipped ? 'admin-status-shipped' : 'admin-status-pending'}">${shipped ? 'Expédiée' : 'En attente'}</span></td>
          <td data-label="Suivi">${order.tracking_number ? `<span class="admin-tracking-value">${escapeHtml(order.tracking_number)}</span>` : '—'}</td>
      `;

      // Shipped orders keep the old direct-to-modal action ("Modifier le
      // suivi" -- item 3's correction path, untouched by this round's
      // inline-reveal change, see openShipModal()'s own comment on why).
      if (shipped) {
        return `
          <tr class="admin-order-row-shipped" data-order-id="${order.id}">
            ${commonCells}
            <td data-label=""><button type="button" class="admin-ship-btn" data-ship-order-id="${order.id}">Modifier le suivi</button></td>
          </tr>
        `;
      }

      // Pending orders: "Expédier" triggers the inline reveal row right
      // below (revealOrderRow()) instead of opening the modal directly --
      // pre-rendered hidden here, same "hidden until needed" pattern as the
      // modal's own address/tracking blocks.
      return `
        <tr data-order-id="${order.id}">
          ${commonCells}
          <td data-label=""><button type="button" class="admin-ship-btn" data-reveal-order-id="${order.id}">Expédier</button></td>
        </tr>
        <tr class="admin-order-reveal-row" data-reveal-row-for="${order.id}" hidden>
          <td colspan="8" class="admin-order-reveal-cell">
            <div class="admin-order-reveal-address">
              <label>Adresse de livraison</label>
              <p>${formatShippingAddress(order)}</p>
            </div>
            <div class="admin-order-reveal-actions">
              <button type="button" class="admin-order-reveal-cancel" data-reveal-cancel-id="${order.id}">Annuler</button>
              <button type="button" class="admin-order-reveal-confirm" data-reveal-ship-id="${order.id}">Expédié</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbodyEl.querySelectorAll('[data-ship-order-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const order = ordersCache.find((o) => o.id === btn.getAttribute('data-ship-order-id'));
        if (order) openShipModal(order);
      });
    });

    // "Expédier" -- shows the reveal row in place of this button (see
    // revealOrderRow()) instead of opening the modal, so the customer's
    // name/address is one click away, not two.
    tbodyEl.querySelectorAll('[data-reveal-order-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const orderId = btn.getAttribute('data-reveal-order-id');
        const order = ordersCache.find((o) => o.id === orderId);
        if (order) revealOrderRow(order, btn);
      });
    });

    tbodyEl.querySelectorAll('[data-reveal-cancel-id]').forEach((btn) => {
      btn.addEventListener('click', () => hideOrderRowReveal(btn.getAttribute('data-reveal-cancel-id')));
    });

    // "Expédié" (inline, black/gold) -- opens the SAME mark-as-shipped modal
    // "Expédier" used to open directly, just already past its own reveal
    // gate (see openShipModal()'s startRevealed param) since the address was
    // already shown right here a moment ago.
    tbodyEl.querySelectorAll('[data-reveal-ship-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const orderId = btn.getAttribute('data-reveal-ship-id');
        const order = ordersCache.find((o) => o.id === orderId);
        if (order) openShipModal(order, { startRevealed: true });
      });
    });

    tbodyEl.querySelectorAll('.admin-product-truncated').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('admin-product-expanded'));
    });
  }

  // Swaps a pending order's own "Expédier" button for the full-width reveal
  // row right below it (pre-rendered hidden in renderOrders(), see that
  // function's own comment) -- "replacing the button itself," not just
  // adding content alongside it, so `btn` (the clicked "Expédier") is hidden
  // here too, not left sitting there still clickable.
  function revealOrderRow(order, btn) {
    btn.hidden = true;
    const row = tbodyEl.querySelector(`[data-reveal-row-for="${order.id}"]`);
    if (row) row.hidden = false;
  }

  // "Annuler" -- reverses revealOrderRow(): hides the reveal row, re-shows
  // the "Expédier" button it replaced. Looks the button up fresh by
  // selector rather than capturing it in a closure -- simpler than plumbing
  // it through two more click handlers for the same result.
  function hideOrderRowReveal(orderId) {
    const row = tbodyEl.querySelector(`[data-reveal-row-for="${orderId}"]`);
    if (row) row.hidden = true;
    const btn = tbodyEl.querySelector(`[data-reveal-order-id="${orderId}"]`);
    if (btn) btn.hidden = false;
  }

  // ---------------- Mark-as-shipped / edit-tracking modal ----------------
  const modal = document.getElementById('admin-ship-modal');
  const modalTitleEl = document.getElementById('admin-ship-modal-title');
  const modalRefEl = document.getElementById('admin-ship-modal-ref');
  const modalErrorEl = document.getElementById('admin-ship-modal-error');
  const revealBtn = document.getElementById('admin-ship-reveal-btn');
  const addressBlockEl = document.getElementById('admin-ship-address-block');
  const addressTextEl = document.getElementById('admin-ship-address-text');
  const trackingFieldsEl = document.getElementById('admin-ship-tracking-fields');
  const carrierSelect = document.getElementById('admin-carrier-select');
  const trackingInput = document.getElementById('admin-tracking-input');
  const shipConfirmBtn = document.getElementById('admin-ship-confirm');
  const shipCancelBtn = document.getElementById('admin-ship-cancel');

  let orderBeingShipped = null;

  // Address lines joined with real <br> line breaks (via innerHTML, hence
  // escapeHtml on every piece going in) rather than one run-on paragraph --
  // this is meant to be read at a glance like a shipping label, not a
  // sentence. Line1/Line2 only included when actually present -- an order
  // whose PaymentIntent predates 20260821000000_order_shipping_address_and_carrier.sql
  // (or one that was never attributable to a real shipping_name at all) has
  // some or all of these as null; this never fabricates a placeholder for a
  // missing piece, it just omits that line.
  function formatShippingAddress(order) {
    const lines = [
      order.shipping_name,
      order.shipping_address_line1,
      order.shipping_address_line2,
      [order.shipping_postal_code, order.shipping_city].filter(Boolean).join(' '),
      order.shipping_country,
    ].filter(Boolean);
    if (!lines.length) return 'Adresse non disponible pour cette commande.';
    return lines.map(escapeHtml).join('<br>');
  }

  // The reveal gate itself -- see admin.html's own comment on
  // #admin-ship-reveal-btn. Unhides the address + carrier/tracking fields
  // (and the Confirm button, so there's genuinely nothing submittable
  // before this runs, not just something visually hidden) and pre-fills
  // the carrier/tracking values for a correction, exactly like
  // trackingInput's own pre-fill already did before this change.
  function revealShippingInfo() {
    if (!orderBeingShipped) return;
    addressTextEl.innerHTML = formatShippingAddress(orderBeingShipped);
    addressBlockEl.hidden = false;
    trackingFieldsEl.hidden = false;
    shipConfirmBtn.hidden = false;
    revealBtn.hidden = true;
    const alreadyShipped = orderBeingShipped.shipping_status === 'shipped';
    carrierSelect.value = alreadyShipped && orderBeingShipped.carrier ? orderBeingShipped.carrier : '';
    trackingInput.focus();
    trackingInput.select();
  }

  // `startRevealed` -- used by the orders row's own inline "Expédié" action
  // (js/admin.js's revealOrderRow()/the [data-reveal-ship-id] handler
  // above): the address was already shown right there in the table a
  // moment ago, so this modal opens straight past its own reveal gate
  // instead of making the admin click "Afficher les infos d'expédition"
  // again for information they just saw. "Modifier le suivi" (already-
  // shipped correction path) never passes this -- unaffected, still opens
  // on the reveal gate exactly as before.
  function openShipModal(order, { startRevealed = false } = {}) {
    orderBeingShipped = order;
    const alreadyShipped = order.shipping_status === 'shipped';
    modalTitleEl.textContent = alreadyShipped ? 'Modifier le numéro de suivi' : 'Expédier';
    modalRefEl.textContent = alreadyShipped
      ? `Commande ${order.reference_number || order.id} -- déjà expédiée. Un nouveau numéro enverra un e-mail de correction au client (pas un second e-mail d'expédition).`
      : `Commande ${order.reference_number || order.id}`;
    // Pre-filled with the existing number when editing -- an admin
    // correcting a typo shouldn't have to retype the whole thing, and
    // leaving it blank would make it too easy to accidentally resubmit the
    // exact same value expecting nothing to happen (it wouldn't send an
    // email either way, see mark-order-shipped's own trackingChanged check,
    // but a visibly pre-filled field is the clearer UI regardless). Still
    // set here (not just in revealShippingInfo()) so it's already correct
    // the moment the fields become visible, with no flash of an empty value.
    trackingInput.value = alreadyShipped ? (order.tracking_number || '') : '';
    modalErrorEl.textContent = '';
    // Reset the reveal gate every time this opens -- see admin.html's own
    // comment: no exception for "Modifier le suivi" on an already-shipped
    // order, the address/tracking fields start hidden again regardless
    // (still true here -- startRevealed reveals them again immediately
    // below, it doesn't skip this reset).
    addressBlockEl.hidden = true;
    trackingFieldsEl.hidden = true;
    shipConfirmBtn.hidden = true;
    revealBtn.hidden = false;
    modal.hidden = false;
    if (startRevealed) {
      // Same reveal as a manual reveal-gate click -- address block, tracking
      // fields, and Confirm all shown together (see revealShippingInfo()'s
      // own comment on why address stays visible here too, not just the
      // tracking fields, per this change's own requirement).
      revealShippingInfo();
    } else {
      revealBtn.focus();
    }
  }

  function closeShipModal() {
    modal.hidden = true;
    orderBeingShipped = null;
  }

  revealBtn.addEventListener('click', revealShippingInfo);
  shipCancelBtn.addEventListener('click', closeShipModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeShipModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeShipModal();
  });

  shipConfirmBtn.addEventListener('click', async () => {
    const trackingNumber = trackingInput.value.trim();
    const carrier = carrierSelect.value;
    if (!carrier) {
      modalErrorEl.textContent = 'Merci de choisir un transporteur.';
      carrierSelect.focus();
      return;
    }
    if (!trackingNumber) {
      modalErrorEl.textContent = 'Merci de renseigner un numéro de suivi.';
      trackingInput.focus();
      return;
    }
    if (!orderBeingShipped) return;

    // Only prompts for an actual CORRECTION -- an order already marked
    // shipped, where the tracking number OR the carrier is genuinely
    // changing (not just resubmitted unchanged, which mark-order-shipped's
    // own trackingChanged check wouldn't email for anyway, see
    // openShipModal()'s own comment -- extended to carrier for the same
    // reason as that function's own comment on why a carrier-only change
    // still counts as a correction). First-time "mark as shipped"
    // (shipping_status !== 'shipped') never hits this -- that's the
    // expected, no-confirmation-needed action.
    const isCorrection = orderBeingShipped.shipping_status === 'shipped'
      && (trackingNumber !== (orderBeingShipped.tracking_number || '') || carrier !== (orderBeingShipped.carrier || ''));
    if (isCorrection && !window.confirm("Ce numéro de suivi va être modifié. Un e-mail de correction sera envoyé au client. Confirmer ?")) {
      return;
    }

    shipConfirmBtn.disabled = true;
    modalErrorEl.textContent = '';

    // Routed through the mark-order-shipped Edge Function, NOT a direct
    // .from('orders').update() -- that function is also what decides
    // "first-time shipment" vs. "correction" (by re-checking the order's
    // CURRENT shipping_status/tracking_number server-side, not trusting
    // whatever this tab happened to have cached) and sends the matching
    // email. supabase-js's functions.invoke() attaches this admin's own
    // current session as the Authorization header automatically -- that's
    // what the function's own is_admin check runs against.
    const { data, error } = await client().functions.invoke('mark-order-shipped', {
      body: { orderId: orderBeingShipped.id, trackingNumber, carrier },
    });

    shipConfirmBtn.disabled = false;

    if (error || !data || data.error) {
      modalErrorEl.textContent = `Échec de la mise à jour : ${(data && data.error) || error.message}`;
      console.error('admin.js ship update:', (data && data.error) || error.message);
      return;
    }

    closeShipModal();
    loadOrders();
  });

  // ---------------- Promo Codes tab ----------------
  let promoCache = []; // last successful fetch, re-rendered from after every save (no diffing -- this table is small)

  const promoLoadingEl = document.getElementById('admin-promo-loading');
  const promoErrorEl = document.getElementById('admin-promo-error');
  const promoEmptyEl = document.getElementById('admin-promo-empty');
  const promoTableEl = document.getElementById('admin-promo-table');
  const promoTbodyEl = document.getElementById('admin-promo-tbody');
  const promoAddBtn = document.getElementById('admin-promo-add-btn');

  function initPromoCodes() {
    promoAddBtn.addEventListener('click', () => openPromoModal(null));
    loadPromoCodes();
  }

  async function loadPromoCodes() {
    promoLoadingEl.hidden = false;
    promoErrorEl.hidden = true;
    promoEmptyEl.hidden = true;
    promoTableEl.hidden = true;

    const { data: promos, error } = await client()
      .from('promo_codes')
      .select('id, code, discount_percent, active, max_uses, times_used, expires_at')
      .order('created_at', { ascending: false });

    promoLoadingEl.hidden = true;

    if (error) {
      promoErrorEl.hidden = false;
      promoErrorEl.textContent = `Erreur lors du chargement des codes promo : ${error.message}`;
      console.error('admin.js loadPromoCodes:', error.message);
      return;
    }

    promoCache = promos;
    renderPromoCodes();
  }

  // null max_uses = unlimited (see public.promo_codes' own column comment) --
  // shown as a bare count rather than "X / illimité", same "don't show a
  // fabricated ceiling" spirit as the rest of this tool.
  function usageLabel(promo) {
    return promo.max_uses === null ? `${promo.times_used}` : `${promo.times_used} / ${promo.max_uses}`;
  }

  function renderPromoCodes() {
    if (!promoCache.length) {
      promoTableEl.hidden = true;
      promoEmptyEl.hidden = false;
      promoTbodyEl.innerHTML = '';
      return;
    }

    promoEmptyEl.hidden = true;
    promoTableEl.hidden = false;
    promoTbodyEl.innerHTML = promoCache.map((promo) => `
        <tr data-promo-id="${promo.id}">
          <td data-label="Code">${escapeHtml(promo.code)}</td>
          <td data-label="Réduction">${promo.discount_percent}%</td>
          <td data-label="Statut"><span class="admin-status-pill ${promo.active ? 'admin-status-active' : 'admin-status-inactive'}">${promo.active ? 'Actif' : 'Inactif'}</span></td>
          <td data-label="Utilisations">${usageLabel(promo)}</td>
          <td data-label="Expire le">${promo.expires_at ? formatDate(promo.expires_at) : '—'}</td>
          <td data-label="">
            <button type="button" class="admin-ship-btn" data-edit-promo-id="${promo.id}">Modifier</button>
            <button type="button" class="admin-delete-btn" data-delete-promo-id="${promo.id}">Supprimer</button>
          </td>
        </tr>
      `).join('');

    promoTbodyEl.querySelectorAll('[data-edit-promo-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const promo = promoCache.find((p) => p.id === btn.getAttribute('data-edit-promo-id'));
        if (promo) openPromoModal(promo);
      });
    });

    promoTbodyEl.querySelectorAll('[data-delete-promo-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const promo = promoCache.find((p) => p.id === btn.getAttribute('data-delete-promo-id'));
        if (promo) deletePromoCode(promo);
      });
    });
  }

  // Irreversible and could affect a customer who already has this code
  // applied -- confirm() first (same native-dialog pattern as the ship
  // modal's own correction-email confirm), then a FRESH check (not cached)
  // of site_config.promo_remaining_code_id: deleting the code the "codes
  // promo restants" counter above is currently tracking is blocked rather
  // than silently clearing that selection -- same block-and-guide
  // philosophy that section's own max_uses guard already uses, not a
  // silent fallback to Fixe mode (see this feature's own migration
  // comment). The DB's own FK (no ON DELETE clause -- NO ACTION) would
  // reject the delete anyway if this check somehow races against a
  // just-saved selection; alert() below covers that case with the same
  // friendly message instead of a raw constraint error.
  async function deletePromoCode(promo) {
    if (!window.confirm(`Supprimer définitivement le code ${promo.code} ? Cette action est irréversible et affectera tout client qui l'a déjà appliqué.`)) {
      return;
    }

    const { data: config } = await client()
      .from('site_config')
      .select('promo_remaining_code_id')
      .limit(1)
      .maybeSingle();

    if (config && config.promo_remaining_code_id === promo.id) {
      window.alert(`Le code ${promo.code} est actuellement sélectionné dans le compteur « codes promo restants » ci-dessus. Choisissez-y un autre code, enregistrez, puis réessayez de supprimer ${promo.code}.`);
      return;
    }

    const { error } = await client().from('promo_codes').delete().eq('id', promo.id);

    if (error) {
      if (error.code === '23503') {
        window.alert(`Le code ${promo.code} est actuellement sélectionné dans le compteur « codes promo restants » ci-dessus. Choisissez-y un autre code, enregistrez, puis réessayez de supprimer ${promo.code}.`);
      } else {
        window.alert(`Échec de la suppression : ${error.message}`);
        console.error('admin.js deletePromoCode:', error.message);
      }
      return;
    }

    loadPromoCodes();
  }

  // ---------------- Promo code create/edit modal ----------------
  const promoModal = document.getElementById('admin-promo-modal');
  const promoModalTitleEl = document.getElementById('admin-promo-modal-title');
  const promoModalErrorEl = document.getElementById('admin-promo-modal-error');
  const promoCodeInput = document.getElementById('admin-promo-code-input');
  const promoDiscountInput = document.getElementById('admin-promo-discount-input');
  const promoActiveInput = document.getElementById('admin-promo-active-input');
  const promoMaxUsesInput = document.getElementById('admin-promo-maxuses-input');
  const promoExpiresInput = document.getElementById('admin-promo-expires-input');
  const promoConfirmBtn = document.getElementById('admin-promo-confirm');
  const promoCancelBtn = document.getElementById('admin-promo-cancel');

  let promoBeingEdited = null; // null = create mode

  // timestamptz -> the local, no-timezone, no-seconds value <input
  // type="datetime-local"> expects. Date's own getters below read in the
  // browser's LOCAL time, same as the input displays/edits in, so this and
  // the reverse conversion in the confirm handler below never shift the
  // moment an admin actually sees or picks.
  function toDatetimeLocalValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openPromoModal(promo) {
    promoBeingEdited = promo;
    const editing = !!promo;
    promoModalTitleEl.textContent = editing ? `Modifier ${promo.code}` : 'Nouveau code promo';
    promoCodeInput.value = editing ? promo.code : '';
    // Code is only ever set at creation -- see this feature's own migration
    // comment on why renaming a live code isn't offered here (would silently
    // invalidate whatever a customer already has applied at checkout).
    promoCodeInput.readOnly = editing;
    promoDiscountInput.value = editing ? promo.discount_percent : '';
    promoActiveInput.checked = editing ? promo.active : true;
    promoMaxUsesInput.value = editing && promo.max_uses !== null ? promo.max_uses : '';
    promoExpiresInput.value = editing ? toDatetimeLocalValue(promo.expires_at) : '';
    promoModalErrorEl.textContent = '';
    promoModal.hidden = false;
    promoCodeInput.focus();
  }

  function closePromoModal() {
    promoModal.hidden = true;
    promoBeingEdited = null;
  }

  promoCancelBtn.addEventListener('click', closePromoModal);
  promoModal.addEventListener('click', (e) => { if (e.target === promoModal) closePromoModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !promoModal.hidden) closePromoModal();
  });

  promoConfirmBtn.addEventListener('click', async () => {
    const editing = !!promoBeingEdited;
    const code = promoCodeInput.value.trim().toUpperCase();
    if (!editing && !code) {
      promoModalErrorEl.textContent = 'Merci de renseigner un code.';
      promoCodeInput.focus();
      return;
    }

    // Same bounds as public.promo_codes' own check constraint
    // (discount_percent > 0 and <= 100) -- mirrored here so a bad value is
    // caught before the round-trip, not just rejected server-side.
    const discountPercent = Number(promoDiscountInput.value);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      promoModalErrorEl.textContent = 'La réduction doit être comprise entre 0 et 100 %.';
      promoDiscountInput.focus();
      return;
    }

    const maxUsesRaw = promoMaxUsesInput.value.trim();
    let maxUses = null;
    if (maxUsesRaw) {
      maxUses = Math.floor(Number(maxUsesRaw));
      if (!Number.isFinite(maxUses) || maxUses < 1) {
        promoModalErrorEl.textContent = "Le nombre d'utilisations max doit être un entier positif (ou vide pour illimité).";
        promoMaxUsesInput.focus();
        return;
      }
    }

    // datetime-local's own value has no timezone -- new Date() on it parses
    // as the browser's LOCAL time, and toISOString() converts that to the
    // UTC instant public.promo_codes.expires_at (timestamptz) actually
    // stores, the same interpretation toDatetimeLocalValue() above uses in
    // reverse.
    const expiresRaw = promoExpiresInput.value;
    const expiresAt = expiresRaw ? new Date(expiresRaw).toISOString() : null;

    promoConfirmBtn.disabled = true;
    promoModalErrorEl.textContent = '';

    const patch = {
      discount_percent: discountPercent,
      active: promoActiveInput.checked,
      max_uses: maxUses,
      expires_at: expiresAt,
    };

    // Direct client insert/update (not routed through an Edge Function like
    // mark-order-shipped) -- unlike that action, this one has no secret to
    // protect and no server-side decision to make beyond what RLS +
    // column-scoped grants already enforce (see this feature's own
    // migration), so the extra round-trip through a function would add
    // nothing.
    const { error } = editing
      ? await client().from('promo_codes').update(patch).eq('id', promoBeingEdited.id)
      : await client().from('promo_codes').insert({ ...patch, code });

    promoConfirmBtn.disabled = false;

    if (error) {
      // Postgres' own unique_violation on promo_codes.code -- surfaced as a
      // plain-language message rather than the raw 23505/constraint name.
      promoModalErrorEl.textContent = error.code === '23505'
        ? 'Ce code existe déjà.'
        : `Échec de l'enregistrement : ${error.message}`;
      console.error('admin.js promo save:', error.message);
      return;
    }

    closePromoModal();
    loadPromoCodes();
  });

  // ---------------- Promo remaining-count config (site_config) ----------------
  // Governs the "codes remaining" urgency line on js/email-popup.js. Moved
  // here from the Timer tab (which only ever kept a flat manual number)
  // because 'real' mode reads straight off the SELECTED code's own
  // max_uses/times_used below -- that only makes sense configured next to
  // the promo code table itself, not the countdown. Same non-modal
  // .admin-modal-content reuse as the Timer/Stock tabs (see admin.html's
  // own comment).
  let promoRemainingConfigCache = null; // { id, promo_remaining_mode, promo_codes_remaining, promo_remaining_code_id }

  const promoRemainingLoadingEl = document.getElementById('admin-promo-remaining-loading');
  const promoRemainingErrorEl = document.getElementById('admin-promo-remaining-error');
  const promoRemainingFormEl = document.getElementById('admin-promo-remaining-form');
  const promoRemainingModeFixedInput = document.getElementById('admin-promo-remaining-mode-fixed');
  const promoRemainingModeRealInput = document.getElementById('admin-promo-remaining-mode-real');
  const promoRemainingFixedFieldsEl = document.getElementById('admin-promo-remaining-fixed-fields');
  const promoRemainingCountInput = document.getElementById('admin-promo-remaining-count-input');
  const promoRemainingCodeSelect = document.getElementById('admin-promo-remaining-code-select');
  const promoRemainingPreviewEl = document.getElementById('admin-promo-remaining-preview');
  const promoRemainingFormErrorEl = document.getElementById('admin-promo-remaining-form-error');
  const promoRemainingFormSuccessEl = document.getElementById('admin-promo-remaining-form-success');
  const promoRemainingSaveBtn = document.getElementById('admin-promo-remaining-save');

  function initPromoRemainingConfig() {
    promoRemainingModeFixedInput.addEventListener('change', () => {
      updatePromoRemainingModeFields();
      updatePromoRemainingPreview();
    });
    promoRemainingModeRealInput.addEventListener('change', () => {
      updatePromoRemainingModeFields();
      updatePromoRemainingPreview();
    });
    promoRemainingCodeSelect.addEventListener('change', updatePromoRemainingPreview);
    promoRemainingSaveBtn.addEventListener('click', savePromoRemainingConfig);
    loadPromoRemainingConfig();
  }

  async function loadPromoRemainingConfig() {
    promoRemainingLoadingEl.hidden = false;
    promoRemainingErrorEl.hidden = true;
    promoRemainingFormEl.hidden = true;

    // Two independent reads -- site_config (this feature's own settings) and
    // the full promo_codes list (to populate the dropdown) -- not the Promo
    // Codes tab's own promoCache, since this tab's load order can't
    // guarantee that's populated yet (same reasoning savePromoRemainingConfig()
    // below already applied to its own max_uses check).
    const [{ data, error }, { data: codes, error: codesError }] = await Promise.all([
      client().from('site_config').select('id, promo_remaining_mode, promo_codes_remaining, promo_remaining_code_id').limit(1).maybeSingle(),
      client().from('promo_codes').select('id, code').order('created_at', { ascending: true }),
    ]);

    promoRemainingLoadingEl.hidden = true;

    if (error || !data || codesError) {
      promoRemainingErrorEl.hidden = false;
      promoRemainingErrorEl.textContent = (error || codesError)
        ? `Erreur lors du chargement : ${(error || codesError).message}`
        : 'Configuration introuvable.';
      if (error) console.error('admin.js loadPromoRemainingConfig:', error.message);
      if (codesError) console.error('admin.js loadPromoRemainingConfig (codes):', codesError.message);
      return;
    }

    if (!codes.length) {
      promoRemainingErrorEl.hidden = false;
      promoRemainingErrorEl.textContent = 'Aucun code promo disponible -- créez-en un dans le tableau ci-dessus avant de configurer ce compteur.';
      return;
    }

    promoRemainingConfigCache = data;
    promoRemainingModeFixedInput.checked = data.promo_remaining_mode !== 'real';
    promoRemainingModeRealInput.checked = data.promo_remaining_mode === 'real';
    promoRemainingCountInput.value = data.promo_codes_remaining;

    // Defaults to whichever code is already selected in site_config, or the
    // oldest existing code (codes is ordered created_at ascending above) if
    // none is set yet -- see this feature's own migration comment.
    promoRemainingCodeSelect.innerHTML = codes.map((c) => `<option value="${c.id}">${escapeHtml(c.code)}</option>`).join('');
    const preselected = data.promo_remaining_code_id && codes.some((c) => c.id === data.promo_remaining_code_id)
      ? data.promo_remaining_code_id
      : codes[0].id;
    promoRemainingCodeSelect.value = preselected;

    updatePromoRemainingModeFields();
    updatePromoRemainingPreview();
    promoRemainingFormErrorEl.textContent = '';
    promoRemainingFormSuccessEl.hidden = true;
    promoRemainingFormEl.hidden = false;
  }

  function updatePromoRemainingModeFields() {
    promoRemainingFixedFieldsEl.hidden = promoRemainingModeRealInput.checked;
  }

  // Read-only live preview of what Réel mode would show right now, for
  // whichever code is currently selected in the dropdown -- never written
  // anywhere, purely informational, updated on mode/selection change (see
  // initPromoRemainingConfig()'s own listeners). Hidden in Fixe mode, or
  // whenever the selected code has no max_uses set (nothing to compute).
  async function updatePromoRemainingPreview() {
    if (!promoRemainingModeRealInput.checked || !promoRemainingCodeSelect.value) {
      promoRemainingPreviewEl.hidden = true;
      return;
    }
    const { data: promo, error } = await client()
      .from('promo_codes')
      .select('max_uses, times_used')
      .eq('id', promoRemainingCodeSelect.value)
      .maybeSingle();

    if (error || !promo || promo.max_uses === null) {
      promoRemainingPreviewEl.hidden = true;
      return;
    }
    promoRemainingPreviewEl.hidden = false;
    promoRemainingPreviewEl.textContent = `Restant actuel : ${Math.max(0, promo.max_uses - promo.times_used)}`;
  }

  async function savePromoRemainingConfig() {
    if (!promoRemainingConfigCache) return;
    const mode = promoRemainingModeRealInput.checked ? 'real' : 'fixed';
    const codeId = promoRemainingCodeSelect.value;
    promoRemainingFormErrorEl.textContent = '';
    promoRemainingFormSuccessEl.hidden = true;

    if (!codeId) {
      promoRemainingFormErrorEl.textContent = 'Merci de sélectionner un code promo.';
      return;
    }

    const patch = { promo_remaining_mode: mode, promo_remaining_code_id: codeId };

    if (mode === 'fixed') {
      const count = Math.floor(Number(promoRemainingCountInput.value));
      if (!Number.isFinite(count) || count < 0) {
        promoRemainingFormErrorEl.textContent = 'Le nombre de codes promo restants doit être un entier positif ou nul.';
        promoRemainingCountInput.focus();
        return;
      }
      patch.promo_codes_remaining = count;
    } else {
      // Fresh lookup, not promoCache or the preview's own last-read value --
      // this tab's own order-of-loading can't guarantee promoCache is
      // populated, and either could be stale right after an edit in the
      // modal above. The SELECTED code's max_uses must already be set
      // before 'real' mode can compute anything meaningful. Blocked here,
      // never silently defaulted/auto-filled.
      promoRemainingSaveBtn.disabled = true;
      const { data: promo, error: promoError } = await client()
        .from('promo_codes')
        .select('code, max_uses')
        .eq('id', codeId)
        .maybeSingle();
      promoRemainingSaveBtn.disabled = false;

      if (promoError || !promo) {
        promoRemainingFormErrorEl.textContent = 'Impossible de vérifier ce code pour le moment.';
        console.error('admin.js savePromoRemainingConfig (max_uses check):', promoError && promoError.message);
        return;
      }
      if (promo.max_uses === null) {
        promoRemainingFormErrorEl.textContent = `Merci de définir un nombre d'utilisations max pour ${promo.code} (onglet Codes Promo, ci-dessus) avant de passer en mode réel.`;
        return;
      }
    }

    promoRemainingSaveBtn.disabled = true;

    const { error } = await client().from('site_config').update(patch).eq('id', promoRemainingConfigCache.id);

    promoRemainingSaveBtn.disabled = false;

    if (error) {
      promoRemainingFormErrorEl.textContent = `Échec de l'enregistrement : ${error.message}`;
      console.error('admin.js savePromoRemainingConfig:', error.message);
      return;
    }

    promoRemainingConfigCache = { ...promoRemainingConfigCache, ...patch };
    promoRemainingFormSuccessEl.hidden = false;
  }

  // ---------------- Timer tab ----------------
  // Single-row settings, not a list -- no modal, just a persistent form
  // directly in the panel (see admin.html's own comment on why
  // .admin-modal-content is safe to reuse outside a .admin-modal overlay).
  let timerConfigCache = null; // { id, timer_mode, relative_duration_hours, relative_duration_minutes, relative_duration_seconds, fixed_end_date }

  const timerLoadingEl = document.getElementById('admin-timer-loading');
  const timerErrorEl = document.getElementById('admin-timer-error');
  const timerFormEl = document.getElementById('admin-timer-form');
  const timerModeRelativeInput = document.getElementById('admin-timer-mode-relative');
  const timerModeFixedInput = document.getElementById('admin-timer-mode-fixed');
  const timerRelativeFieldsEl = document.getElementById('admin-timer-relative-fields');
  const timerFixedFieldsEl = document.getElementById('admin-timer-fixed-fields');
  const timerHoursInput = document.getElementById('admin-timer-hours-input');
  const timerMinutesInput = document.getElementById('admin-timer-minutes-input');
  const timerSecondsInput = document.getElementById('admin-timer-seconds-input');
  const timerDateInput = document.getElementById('admin-timer-date-input');
  const timerFormErrorEl = document.getElementById('admin-timer-form-error');
  const timerFormSuccessEl = document.getElementById('admin-timer-form-success');
  const timerSaveBtn = document.getElementById('admin-timer-save');

  function initTimerConfig() {
    timerModeRelativeInput.addEventListener('change', updateTimerModeFields);
    timerModeFixedInput.addEventListener('change', updateTimerModeFields);
    timerSaveBtn.addEventListener('click', saveTimerConfig);
    loadTimerConfig();
  }

  async function loadTimerConfig() {
    timerLoadingEl.hidden = false;
    timerErrorEl.hidden = true;
    timerFormEl.hidden = true;

    const { data, error } = await client()
      .from('site_config')
      .select('id, timer_mode, relative_duration_hours, relative_duration_minutes, relative_duration_seconds, fixed_end_date')
      .limit(1)
      .maybeSingle();

    timerLoadingEl.hidden = true;

    if (error || !data) {
      timerErrorEl.hidden = false;
      timerErrorEl.textContent = error
        ? `Erreur lors du chargement du minuteur : ${error.message}`
        : 'Configuration du minuteur introuvable.';
      if (error) console.error('admin.js loadTimerConfig:', error.message);
      return;
    }

    timerConfigCache = data;
    timerModeRelativeInput.checked = data.timer_mode === 'relative';
    timerModeFixedInput.checked = data.timer_mode === 'fixed_date';
    timerHoursInput.value = data.relative_duration_hours;
    timerMinutesInput.value = data.relative_duration_minutes;
    timerSecondsInput.value = data.relative_duration_seconds;
    // toDatetimeLocalValue() (defined above, Promo Codes tab's own modal) --
    // shared here rather than duplicated, same timestamptz <-> local
    // datetime-local conversion either field needs.
    timerDateInput.value = data.fixed_end_date ? toDatetimeLocalValue(data.fixed_end_date) : '';
    updateTimerModeFields();
    timerFormErrorEl.textContent = '';
    timerFormSuccessEl.hidden = true;
    timerFormEl.hidden = false;
  }

  function updateTimerModeFields() {
    const isFixed = timerModeFixedInput.checked;
    timerRelativeFieldsEl.hidden = isFixed;
    timerFixedFieldsEl.hidden = !isFixed;
  }

  async function saveTimerConfig() {
    if (!timerConfigCache) return;
    const mode = timerModeFixedInput.checked ? 'fixed_date' : 'relative';
    timerFormErrorEl.textContent = '';
    timerFormSuccessEl.hidden = true;

    const patch = { timer_mode: mode };

    if (mode === 'relative') {
      const hours = Math.floor(Number(timerHoursInput.value));
      if (!Number.isFinite(hours) || hours < 0) {
        timerFormErrorEl.textContent = 'Les heures doivent être un nombre entier positif ou nul.';
        timerHoursInput.focus();
        return;
      }
      const minutes = Math.floor(Number(timerMinutesInput.value));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) {
        timerFormErrorEl.textContent = 'Les minutes doivent être un entier entre 0 et 59.';
        timerMinutesInput.focus();
        return;
      }
      const seconds = Math.floor(Number(timerSecondsInput.value));
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 59) {
        timerFormErrorEl.textContent = 'Les secondes doivent être un entier entre 0 et 59.';
        timerSecondsInput.focus();
        return;
      }
      // Same "duration must add up to something positive" guarantee
      // relative_duration_hours' own `check (> 0)` gave alone before this
      // feature -- now enforced across all three fields combined, since any
      // one of them alone is allowed to be zero (e.g. "0h 5m 0s").
      if (hours === 0 && minutes === 0 && seconds === 0) {
        timerFormErrorEl.textContent = 'La durée doit être supérieure à zéro.';
        timerHoursInput.focus();
        return;
      }
      patch.relative_duration_hours = hours;
      patch.relative_duration_minutes = minutes;
      patch.relative_duration_seconds = seconds;
    } else {
      if (!timerDateInput.value) {
        timerFormErrorEl.textContent = 'Merci de choisir une date de fin.';
        timerDateInput.focus();
        return;
      }
      // Same local-time interpretation as the Promo Codes modal's own
      // expires_at handling -- datetime-local's value has no timezone,
      // new Date() parses it as the browser's LOCAL time, toISOString()
      // converts that to the UTC instant timestamptz actually stores.
      patch.fixed_end_date = new Date(timerDateInput.value).toISOString();
    }

    timerSaveBtn.disabled = true;

    const { error } = await client().from('site_config').update(patch).eq('id', timerConfigCache.id);

    timerSaveBtn.disabled = false;

    if (error) {
      timerFormErrorEl.textContent = `Échec de l'enregistrement : ${error.message}`;
      console.error('admin.js saveTimerConfig:', error.message);
      return;
    }

    timerConfigCache = { ...timerConfigCache, ...patch };
    timerFormSuccessEl.hidden = false;
  }

  // ---------------- Stock tab ----------------
  // Single product row, same non-modal settings-form pattern as the Timer
  // tab above (see admin.html's own comment on reusing .admin-modal-content
  // outside a .admin-modal overlay) -- not a list, so no table/edit-modal
  // like Orders/Promo Codes needed here.
  let stockProductCache = null; // { id, name, stock_remaining, stock_total }

  const stockLoadingEl = document.getElementById('admin-stock-loading');
  const stockErrorEl = document.getElementById('admin-stock-error');
  const stockFormEl = document.getElementById('admin-stock-form');
  const stockProductNameEl = document.getElementById('admin-stock-product-name');
  const stockRemainingInput = document.getElementById('admin-stock-remaining-input');
  const stockTotalInput = document.getElementById('admin-stock-total-input');
  const stockFormErrorEl = document.getElementById('admin-stock-form-error');
  const stockFormSuccessEl = document.getElementById('admin-stock-form-success');
  const stockSaveBtn = document.getElementById('admin-stock-save');

  function initStock() {
    stockSaveBtn.addEventListener('click', saveStock);
    loadStock();
  }

  async function loadStock() {
    stockLoadingEl.hidden = false;
    stockErrorEl.hidden = true;
    stockFormEl.hidden = true;

    // .limit(1).maybeSingle() -- same "there's only ever one row" convention
    // as every other public.products read in this project (create-checkout-
    // session/stripe-webhook's own price lookups, product.html's own stock
    // read).
    const { data, error } = await client()
      .from('products')
      .select('id, name, stock_remaining, stock_total')
      .limit(1)
      .maybeSingle();

    stockLoadingEl.hidden = true;

    if (error || !data) {
      stockErrorEl.hidden = false;
      stockErrorEl.textContent = error
        ? `Erreur lors du chargement du stock : ${error.message}`
        : 'Produit introuvable.';
      if (error) console.error('admin.js loadStock:', error.message);
      return;
    }

    stockProductCache = data;
    stockProductNameEl.textContent = data.name;
    stockRemainingInput.value = data.stock_remaining;
    stockTotalInput.value = data.stock_total;
    stockFormErrorEl.textContent = '';
    stockFormSuccessEl.hidden = true;
    stockFormEl.hidden = false;
  }

  async function saveStock() {
    if (!stockProductCache) return;
    stockFormErrorEl.textContent = '';
    stockFormSuccessEl.hidden = true;

    const remaining = Math.floor(Number(stockRemainingInput.value));
    if (!Number.isFinite(remaining) || remaining < 0) {
      stockFormErrorEl.textContent = 'Le stock restant doit être un nombre entier positif ou nul.';
      stockRemainingInput.focus();
      return;
    }

    const total = Math.floor(Number(stockTotalInput.value));
    if (!Number.isFinite(total) || total < 0) {
      stockFormErrorEl.textContent = 'Le stock total doit être un nombre entier positif ou nul.';
      stockTotalInput.focus();
      return;
    }

    stockSaveBtn.disabled = true;

    const { error } = await client()
      .from('products')
      .update({ stock_remaining: remaining, stock_total: total })
      .eq('id', stockProductCache.id);

    stockSaveBtn.disabled = false;

    if (error) {
      stockFormErrorEl.textContent = `Échec de l'enregistrement : ${error.message}`;
      console.error('admin.js saveStock:', error.message);
      return;
    }

    stockProductCache = { ...stockProductCache, stock_remaining: remaining, stock_total: total };
    stockFormSuccessEl.hidden = false;
  }

  checkAccessAndInit();
})();
