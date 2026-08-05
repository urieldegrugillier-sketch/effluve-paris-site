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
  }

  // ---------------- Tabs (generic -- see admin.html's own comment) ----------------
  function initTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    const panels = document.querySelectorAll('.admin-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        const target = tab.getAttribute('data-tab');
        panels.forEach((panel) => {
          panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === target);
        });
      });
    });
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
      .select('id, reference_number, user_id, guest_email, product_name, quantity, total, created_at, shipping_status, tracking_number')
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
    if (userIds.length) {
      const { data: profiles, error: profilesError } = await client()
        .from('profiles')
        .select('id, first_name, last_name')
        .in('id', userIds);
      if (profilesError) {
        console.error('admin.js loadOrders (profiles):', profilesError.message);
        // Not fatal -- orders still render, just with a blank customer name
        // for whichever rows needed a profile lookup that failed.
      } else {
        profiles.forEach((p) => {
          profileNameById[p.id] = [p.first_name, p.last_name].filter(Boolean).join(' ');
        });
      }
    }

    ordersCache = orders;
    loadingEl.hidden = true;
    renderOrders();
  }

  function customerLabel(order) {
    if (order.user_id) return profileNameById[order.user_id] || '(compte sans nom)';
    if (order.guest_email) return order.guest_email;
    return '—';
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
      // Shipped orders get an edit action too (not just pending ones) --
      // item 3 needs a way to actually CORRECT a tracking number after the
      // fact, which the previous round's "no button once shipped" design
      // had no path to at all.
      const actionLabel = shipped ? 'Modifier le suivi' : 'Marquer comme expédié';
      return `
        <tr class="${shipped ? 'admin-order-row-shipped' : ''}" data-order-id="${order.id}">
          <td data-label="Référence">${escapeHtml(order.reference_number || '—')}</td>
          <td data-label="Client">${escapeHtml(customerLabel(order))}</td>
          <td data-label="Produit">${productCellHtml(order)}</td>
          <td data-label="Date">${formatDate(order.created_at)}</td>
          <td data-label="Statut"><span class="admin-status-pill ${shipped ? 'admin-status-shipped' : 'admin-status-pending'}">${shipped ? 'Expédiée' : 'En attente'}</span></td>
          <td data-label="Suivi">${order.tracking_number ? `<span class="admin-tracking-value">${escapeHtml(order.tracking_number)}</span>` : '—'}</td>
          <td data-label=""><button type="button" class="admin-ship-btn" data-ship-order-id="${order.id}">${actionLabel}</button></td>
        </tr>
      `;
    }).join('');

    tbodyEl.querySelectorAll('[data-ship-order-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const order = ordersCache.find((o) => o.id === btn.getAttribute('data-ship-order-id'));
        if (order) openShipModal(order);
      });
    });

    tbodyEl.querySelectorAll('.admin-product-truncated').forEach((el) => {
      el.addEventListener('click', () => el.classList.toggle('admin-product-expanded'));
    });
  }

  // ---------------- Mark-as-shipped / edit-tracking modal ----------------
  const modal = document.getElementById('admin-ship-modal');
  const modalTitleEl = document.getElementById('admin-ship-modal-title');
  const modalRefEl = document.getElementById('admin-ship-modal-ref');
  const modalErrorEl = document.getElementById('admin-ship-modal-error');
  const trackingInput = document.getElementById('admin-tracking-input');
  const shipConfirmBtn = document.getElementById('admin-ship-confirm');
  const shipCancelBtn = document.getElementById('admin-ship-cancel');

  let orderBeingShipped = null;

  function openShipModal(order) {
    orderBeingShipped = order;
    const alreadyShipped = order.shipping_status === 'shipped';
    modalTitleEl.textContent = alreadyShipped ? 'Modifier le numéro de suivi' : 'Marquer comme expédié';
    modalRefEl.textContent = alreadyShipped
      ? `Commande ${order.reference_number || order.id} -- déjà expédiée. Un nouveau numéro enverra un e-mail de correction au client (pas un second e-mail d'expédition).`
      : `Commande ${order.reference_number || order.id}`;
    // Pre-filled with the existing number when editing -- an admin
    // correcting a typo shouldn't have to retype the whole thing, and
    // leaving it blank would make it too easy to accidentally resubmit the
    // exact same value expecting nothing to happen (it wouldn't send an
    // email either way, see mark-order-shipped's own trackingChanged check,
    // but a visibly pre-filled field is the clearer UI regardless).
    trackingInput.value = alreadyShipped ? (order.tracking_number || '') : '';
    modalErrorEl.textContent = '';
    modal.hidden = false;
    trackingInput.focus();
    trackingInput.select();
  }

  function closeShipModal() {
    modal.hidden = true;
    orderBeingShipped = null;
  }

  shipCancelBtn.addEventListener('click', closeShipModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeShipModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeShipModal();
  });

  shipConfirmBtn.addEventListener('click', async () => {
    const trackingNumber = trackingInput.value.trim();
    if (!trackingNumber) {
      modalErrorEl.textContent = 'Merci de renseigner un numéro de suivi.';
      trackingInput.focus();
      return;
    }
    if (!orderBeingShipped) return;

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
      body: { orderId: orderBeingShipped.id, trackingNumber },
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

  checkAccessAndInit();
})();
