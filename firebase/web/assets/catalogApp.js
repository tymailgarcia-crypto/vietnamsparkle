import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc
} from "./firebaseClient.js";
import {
  escapeHtml,
  formatCurrency,
  productCategoryKey,
  productImageUrl,
  requireRole,
  slugify,
  withSubmitLock
} from "./shared.js";
import { uploadProductImage, validateProofFile } from "./storageUploads.js";

// Product builder (Ty, 2026-07-17). Owner CRUD over /products — until this
// page, the only writers were the Sheets import script and the Firestore
// console, so a price change needed a developer. Rules already allow
// `write: if isOwner()`; nothing here needed a rules change.
//
// Two invariants the UI enforces on purpose:
//   - Products are retired (active: false), never deleted — orderItems
//     reference them and history must keep resolving.
//   - containerType comes from a fixed select, because it keys the deposit
//     ledger (computeDepositBreakdown) and free text would corrupt it.
//
// Price edits are safe by design: submitPublicOrder re-prices server-side at
// order time and past orders store their own totals.

const state = {
  products: [],
  layout: "cards",
  // Owner-private stock/cost, keyed by product id. Loaded from /inventory,
  // which lives in a separate owner-only collection — supplier cost and exact
  // stock must never reach the public catalog. inventoryAvailable stays false
  // if the read is denied (hosting can reach prod before the rule does), which
  // disables the stock editor without breaking the rest of the builder.
  inventoryByProduct: {},
  inventoryAvailable: false
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function sortedProducts(list) {
  return [...list].sort((a, b) => (Number(a.sortOrder ?? 9999) - Number(b.sortOrder ?? 9999))
    || String(a.productName || "").localeCompare(String(b.productName || "")));
}

const CATEGORY_LABELS = { glass: "Glass bottle water", jug: "Large water jugs", addon: "Extra items" };
const CONTAINER_LABELS = {
  "": "not returnable",
  glass_crate: "glass crate",
  "18_9l_jug": "18.9 L jug",
  "19l_jug": "19 L jug",
  "20l_jug": "20 L jug",
  mixed: "mixed containers"
};

// --- Inventory (owner-private stock & cost) ---------------------------------
// Moved here from settingsApp.js on 2026-07-18 so stock/cost sits next to the
// product it belongs to. The data model is unchanged: public info stays in
// /products, exact stock and supplier cost stay in owner-only /inventory, and
// every stock take appends one immutable /inventoryMovements record. No product
// gets an /inventory doc until it is first counted — it reads "Not counted".

function inventoryNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Terse one-line stock/cost line for a builder row. Mirrors the dialog but
// stays short. Shows on-hand, available (= onHand − reserved), supplier cost,
// and gross margin per unit once counted.
function inventoryRowSummary(product, inventory) {
  if (!state.inventoryAvailable) return "Stock & cost unavailable — deploy the /inventory rule";
  const onHand = inventoryNumber(inventory?.onHand);
  const reserved = inventoryNumber(inventory?.reserved) || 0;
  const costPrice = inventoryNumber(inventory?.costPrice);
  if (onHand === null && costPrice === null) return "Not counted";
  const unit = product.unitLabel || "units";
  const stock = onHand === null
    ? "stock not counted"
    : `${onHand} ${unit} on hand · ${onHand - reserved} available`;
  const margin = costPrice === null
    ? "cost not recorded"
    : `${formatCurrency(costPrice)} cost · ${formatCurrency(Number(product.unitPrice || 0) - costPrice)} margin/unit`;
  return `${stock} · ${margin}`;
}

function renderProductCard(product) {
  const img = productImageUrl(product);
  const thumb = img
    ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="muted" style="font-size:11px">no image</span>`;
  const container = CONTAINER_LABELS[String(product.containerType || "")] ?? String(product.containerType);
  const deposit = Number(product.defaultDepositAmount || 0);
  return `
    <article class="catalog-admin-item${product.active === true ? "" : " is-retired"}">
      <div class="catalog-admin-thumb">${thumb}</div>
      <div class="catalog-admin-body">
        <div class="catalog-admin-head">
          <strong>${escapeHtml(product.productName || product.id)}</strong>
          <code>${escapeHtml(product.id)}</code>
        </div>
        <div class="muted catalog-admin-meta">
          ${escapeHtml(formatCurrency(product.unitPrice))}${product.unitLabel ? ` ${escapeHtml(product.unitLabel)}` : ""}
          · ${CATEGORY_LABELS[productCategoryKey(product)]}
          · ${deposit > 0 ? `${escapeHtml(formatCurrency(deposit))} deposit (${escapeHtml(container)})` : "no deposit"}
          ${product.notes ? ` · ${escapeHtml(product.notes)}` : ""}
        </div>
        <div class="muted catalog-admin-meta" data-inventory-summary="${escapeHtml(product.id)}">${escapeHtml(inventoryRowSummary(product, state.inventoryByProduct[product.id] || {}))}</div>
      </div>
      <div class="button-row catalog-admin-actions">
        <button class="secondary" type="button" data-edit="${escapeHtml(product.id)}">Edit</button>
        <button class="secondary" type="button" data-inventory="${escapeHtml(product.id)}">Stock &amp; cost</button>
        ${product.active === true
          ? `<button class="ghost" type="button" data-retire="${escapeHtml(product.id)}">Retire</button>`
          : `<button class="primary" type="button" data-restore="${escapeHtml(product.id)}">Put back on sale</button>`}
      </div>
    </article>
  `;
}

function renderProducts() {
  const active = sortedProducts(state.products.filter((p) => p.active === true));
  const retired = sortedProducts(state.products.filter((p) => p.active !== true));
  el("product-list").innerHTML = active.length
    ? active.map(renderProductCard).join("")
    : `<p class="muted" style="padding:14px;text-align:center">No products on sale. Add the first one.</p>`;
  el("retired-list").innerHTML = retired.length
    ? retired.map(renderProductCard).join("")
    : `<p class="muted" style="padding:8px 0">Nothing retired.</p>`;
  el("retired-count").textContent = String(retired.length);
  setStatus(`${active.length} on sale · ${retired.length} retired`);

  document.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openProductDialog(state.products.find((p) => p.id === btn.dataset.edit)));
  });
  document.querySelectorAll("[data-inventory]").forEach((btn) => {
    btn.addEventListener("click", () => openInventoryDialog(state.products.find((p) => p.id === btn.dataset.inventory)));
  });
  document.querySelectorAll("[data-retire]").forEach((btn) => {
    btn.addEventListener("click", () => setActive(btn.dataset.retire, false, btn));
  });
  document.querySelectorAll("[data-restore]").forEach((btn) => {
    btn.addEventListener("click", () => setActive(btn.dataset.restore, true, btn));
  });
}

async function setActive(productId, active, button) {
  await withSubmitLock(button, async () => {
    try {
      await updateDoc(doc(db, "products", productId), {
        active,
        updatedAt: new Date().toISOString()
      });
      const product = state.products.find((p) => p.id === productId);
      if (product) product.active = active;
    } catch (error) {
      setStatus(`Could not update ${productId}: ${error.message || error}`);
    }
  });
  renderProducts();
}

// --- Add / edit dialog ------------------------------------------------------

function updateImagePreview() {
  const url = el("product-image-url").value.trim();
  const name = el("product-name").value.trim();
  const effective = url || productImageUrl(name);
  const wrap = el("product-image-preview");
  if (!effective) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  el("product-image-preview-img").src = effective;
  el("product-image-preview-note").textContent = url
    ? "Custom image."
    : "Automatic photo match on the name — set a URL to override.";
}

// Photo upload: runs immediately on file pick and drops the tokenized
// download URL into the Image URL field, so "Save product" persists it like
// any hand-typed URL. For a NOT-yet-saved product the id is derived from the
// name (it's deterministic, P-<slug>), so the blob files under the right
// prefix without a save-first dance. If the owner renames before saving, the
// blob path keeps the old slug — cosmetic only, the token URL is what's
// stored and it never depends on the final doc id.
async function handleImageFilePick(event) {
  const input = event.currentTarget;
  const hint = el("product-image-file-hint");
  const file = input.files && input.files[0];
  if (!file) return;
  const problem = validateProofFile(file);
  if (problem) {
    hint.textContent = problem;
    hint.style.color = "var(--danger, #b3261e)";
    input.value = "";
    return;
  }
  const productId = el("product-id").value.trim()
    || (slugify(el("product-name").value) ? `P-${slugify(el("product-name").value).toUpperCase()}` : "");
  if (!productId) {
    hint.textContent = "Type the product name first, then pick the photo.";
    hint.style.color = "var(--danger, #b3261e)";
    input.value = "";
    return;
  }
  try {
    hint.style.color = "";
    hint.textContent = "Uploading…";
    input.disabled = true;
    const { downloadUrl } = await uploadProductImage({ productId, file });
    el("product-image-url").value = downloadUrl;
    updateImagePreview();
    hint.textContent = "Uploaded — the URL above now points at your photo. Save to keep it.";
  } catch (error) {
    hint.textContent = `Upload failed: ${error.message || error}`;
    hint.style.color = "var(--danger, #b3261e)";
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

function openProductDialog(product) {
  const isEdit = !!product;
  el("product-dialog-title").textContent = isEdit ? `Edit — ${product.productName || product.id}` : "Add product";
  el("product-id").value = isEdit ? product.id : "";
  el("product-name").value = isEdit ? (product.productName || "") : "";
  el("product-price").value = isEdit ? Number(product.unitPrice || 0) : "";
  el("product-deposit").value = isEdit ? Number(product.defaultDepositAmount || 0) : 0;
  el("product-category").value = isEdit ? productCategoryKey(product) : "jug";
  el("product-container-type").value = isEdit ? String(product.containerType || "") : "";
  el("product-unit-label").value = isEdit ? (product.unitLabel || "") : "";
  el("product-sort").value = isEdit && product.sortOrder != null ? Number(product.sortOrder) : "";
  el("product-image-url").value = isEdit ? (product.imageUrl || "") : "";
  el("product-notes").value = isEdit ? (product.notes || "") : "";
  const statusNode = el("product-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  const fileInput = el("product-image-file");
  if (fileInput) fileInput.value = "";
  const fileHint = el("product-image-file-hint");
  if (fileHint) {
    fileHint.textContent = "Uploads immediately and fills the URL above. Photos are compressed automatically; source max 30 MB.";
    fileHint.style.color = "";
  }
  updateImagePreview();
  el("product-dialog").showModal();
}

async function saveProduct(event) {
  event.preventDefault();
  const statusNode = el("product-status");
  const existingId = el("product-id").value.trim();
  const name = el("product-name").value.trim();
  const price = Number(el("product-price").value);
  const deposit = Number(el("product-deposit").value || 0);
  if (!name || !Number.isFinite(price) || price < 0 || deposit < 0) {
    statusNode.textContent = "Name and a non-negative price are required.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const containerType = el("product-container-type").value;
  if (deposit > 0 && !containerType) {
    statusNode.textContent = "A deposit needs a returnable container type — pick one, or set the deposit to 0.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const sortRaw = el("product-sort").value;
  const payload = {
    productName: name,
    category: el("product-category").value,
    containerType: containerType || null,
    unitLabel: el("product-unit-label").value.trim() || null,
    unitPrice: price,
    defaultDepositAmount: deposit,
    imageUrl: el("product-image-url").value.trim() || null,
    notes: el("product-notes").value.trim() || null,
    sortOrder: sortRaw === "" ? null : Number(sortRaw),
    updatedAt: new Date().toISOString()
  };

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving…";
      statusNode.style.color = "";
      let id = existingId;
      if (!id) {
        id = `P-${slugify(name).toUpperCase()}`;
        if (!slugify(name)) throw new Error("Could not build a product id from that name.");
        const clash = await getDoc(doc(db, "products", id));
        if (clash.exists()) {
          throw new Error(`A product with id ${id} already exists — edit that one, or vary the name.`);
        }
        payload.active = true;
        payload.createdAt = payload.updatedAt;
      }
      await setDoc(doc(db, "products", id), payload, { merge: true });
      el("product-dialog").close();
      await loadProducts();
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

// --- Stock & cost dialog ----------------------------------------------------
// A separate dialog from the product editor on purpose: product details save to
// public /products, while stock/cost save to owner-only /inventory with an
// audit movement. Different collections, different audit behaviour — mixing the
// two forms would blur which write goes where.

function recomputeInventoryDialog() {
  const product = state.products.find((p) => p.id === el("inventory-product-id").value);
  if (!product) return;
  const reserved = inventoryNumber(el("inventory-reserved").dataset.value) || 0;
  const onHand = inventoryNumber(el("inventory-on-hand").value.trim());
  const costPrice = inventoryNumber(el("inventory-cost").value.trim());
  const unit = product.unitLabel || "units";
  el("inventory-available").textContent = onHand === null ? "—" : `${onHand - reserved} ${unit}`;
  const retail = Number(product.unitPrice || 0);
  el("inventory-margin").textContent = costPrice === null
    ? `Retail ${formatCurrency(retail)} · supplier cost not set`
    : `Retail ${formatCurrency(retail)} · ${formatCurrency(costPrice)} cost · ${formatCurrency(retail - costPrice)} gross margin per unit`;
}

function openInventoryDialog(product) {
  if (!product) return;
  const inventory = state.inventoryByProduct[product.id] || {};
  const unit = product.unitLabel || "units";
  el("inventory-dialog-title").textContent = `Stock & cost — ${product.productName || product.id}`;
  el("inventory-product-id").value = product.id;
  const onHand = inventoryNumber(inventory.onHand);
  const costPrice = inventoryNumber(inventory.costPrice);
  const reserved = inventoryNumber(inventory.reserved) || 0;
  el("inventory-on-hand").value = onHand === null ? "" : onHand;
  el("inventory-cost").value = costPrice === null ? "" : costPrice;
  const reservedNode = el("inventory-reserved");
  reservedNode.textContent = `${reserved} ${unit}`;
  reservedNode.dataset.value = String(reserved);
  const disabled = !state.inventoryAvailable;
  el("inventory-on-hand").disabled = disabled;
  el("inventory-cost").disabled = disabled;
  el("inventory-save-button").disabled = disabled;
  const status = el("inventory-status");
  status.textContent = disabled
    ? "Inventory access is not active yet. Deploy the Firestore /inventory rule before editing stock."
    : "";
  status.style.color = disabled ? "var(--danger, #b3261e)" : "";
  recomputeInventoryDialog();
  el("inventory-dialog").showModal();
}

async function saveProductInventory(event) {
  if (event?.preventDefault) event.preventDefault();
  const productId = el("inventory-product-id").value;
  const product = state.products.find((p) => p.id === productId);
  const status = el("inventory-status");
  const button = el("inventory-save-button");
  if (!product || !state.inventoryAvailable) return;
  const onHandRaw = el("inventory-on-hand").value.trim();
  const costRaw = el("inventory-cost").value.trim();
  const onHand = Number(onHandRaw);
  const costPrice = Number(costRaw);
  status.style.color = "var(--danger, #b3261e)";
  if (onHandRaw === "" || !Number.isInteger(onHand) || onHand < 0) {
    status.textContent = "Enter a whole on-hand quantity of 0 or more.";
    return;
  }
  if (costRaw === "" || !Number.isFinite(costPrice) || costPrice < 0) {
    status.textContent = "Enter a supplier cost of 0 or more.";
    return;
  }
  await withSubmitLock(button, async () => {
    status.style.color = "";
    status.textContent = "Saving…";
    try {
      const inventoryRef = doc(db, "inventory", productId);
      // Allocate the movement id before the transaction. If Firestore retries
      // the closure, it rewrites the same not-yet-committed row instead of
      // producing duplicate audit movements.
      const movementRef = doc(collection(db, "inventoryMovements"));
      let savedInventory = null;
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(inventoryRef);
        const current = snapshot.exists() ? snapshot.data() : {};
        const storedReserved = inventoryNumber(current.reserved);
        if (storedReserved !== null && (!Number.isInteger(storedReserved) || storedReserved < 0)) {
          throw new Error("Stored reserved stock is invalid. Review this inventory record before counting.");
        }
        const reserved = storedReserved || 0;
        const previousOnHandValue = inventoryNumber(current.onHand);
        if (previousOnHandValue !== null && (!Number.isInteger(previousOnHandValue) || previousOnHandValue < 0)) {
          throw new Error("Stored on-hand stock is invalid. Review this inventory record before counting.");
        }
        const previousOnHand = previousOnHandValue || 0;
        const previousCostPrice = inventoryNumber(current.costPrice);
        const now = serverTimestamp();
        const payload = {
          productId,
          onHand,
          reserved,
          available: onHand - reserved,
          costPrice,
          lastCountedAt: now,
          updatedAt: now,
          updatedByUid: auth.currentUser?.uid || null,
          updatedByEmail: auth.currentUser?.email || null
        };
        transaction.set(inventoryRef, payload, { merge: true });
        transaction.set(movementRef, {
          productId,
          qty: onHand - previousOnHand,
          reason: "stock_take_adjustment",
          linkedOrderId: null,
          linkedPurchaseId: null,
          beforeOnHand: previousOnHand,
          afterOnHand: onHand,
          costPriceBefore: previousCostPrice,
          costPriceAfter: costPrice,
          at: now,
          byUid: auth.currentUser?.uid || null,
          byEmail: auth.currentUser?.email || null
        });
        savedInventory = { ...current, ...payload };
      });
      const saved = { ...savedInventory, lastCountedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.inventoryByProduct[productId] = saved;
      const summaryNode = [...document.querySelectorAll("[data-inventory-summary]")]
        .find((node) => node.getAttribute("data-inventory-summary") === productId);
      if (summaryNode) summaryNode.textContent = inventoryRowSummary(product, saved);
      status.textContent = "Saved.";
      el("inventory-dialog").close();
    } catch (error) {
      status.style.color = "var(--danger, #b3261e)";
      status.textContent = error.message || String(error);
    }
  }, { busyLabel: "Saving…" });
}

// --- Customer storefront layout ---------------------------------------------

function renderLayoutButtons() {
  el("layout-cards-button").setAttribute("aria-pressed", String(state.layout === "cards"));
  el("layout-list-button").setAttribute("aria-pressed", String(state.layout === "list"));
  el("layout-cards-button").classList.toggle("catalog-layout-active", state.layout === "cards");
  el("layout-list-button").classList.toggle("catalog-layout-active", state.layout === "list");
}

async function setLayout(layout, button) {
  const statusNode = el("layout-status");
  await withSubmitLock(button, async () => {
    try {
      statusNode.textContent = "Saving…";
      await setDoc(doc(db, "settings", "business"), {
        catalogLayout: layout,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      state.layout = layout;
      statusNode.textContent = `Customers now see the ${layout} layout.`;
    } catch (error) {
      statusNode.textContent = `Could not save: ${error.message || error}`;
    }
  });
  renderLayoutButtons();
}

// --- Loading -----------------------------------------------------------------

async function loadProducts() {
  setStatus("Loading products…");
  try {
    const snap = await getDocs(collection(db, "products"));
    state.products = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    await loadInventory();
    renderProducts();
  } catch (error) {
    setStatus(`Could not load products: ${error.message || error}`);
  }
}

// Owner-private stock/cost. Kept in a separate try/catch (it never throws) so a
// denied /inventory read leaves the rest of the builder working — the rows just
// show "Not counted"/unavailable and the Stock & cost editor stays disabled.
async function loadInventory() {
  try {
    const snap = await getDocs(collection(db, "inventory"));
    state.inventoryByProduct = Object.fromEntries(snap.docs.map((row) => [row.id, { id: row.id, ...row.data() }]));
    state.inventoryAvailable = true;
  } catch (error) {
    state.inventoryByProduct = {};
    state.inventoryAvailable = false;
    console.warn("Could not load inventory:", error);
  }
}

async function loadLayout() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    state.layout = settings.catalogLayout === "list" ? "list" : "cards";
  } catch (_) {
    state.layout = "cards";
  }
  renderLayoutButtons();
}

el("add-product-button").addEventListener("click", () => openProductDialog(null));
el("refresh-button").addEventListener("click", loadProducts);
el("product-form").addEventListener("submit", saveProduct);
el("product-cancel-button").addEventListener("click", () => el("product-dialog").close());
el("inventory-form").addEventListener("submit", saveProductInventory);
el("inventory-cancel-button").addEventListener("click", () => el("inventory-dialog").close());
el("inventory-on-hand").addEventListener("input", recomputeInventoryDialog);
el("inventory-cost").addEventListener("input", recomputeInventoryDialog);
el("product-image-url").addEventListener("input", updateImagePreview);
el("product-image-file").addEventListener("change", handleImageFilePick);
el("product-name").addEventListener("input", updateImagePreview);
el("layout-cards-button").addEventListener("click", (e) => setLayout("cards", e.currentTarget));
el("layout-list-button").addEventListener("click", (e) => setLayout("list", e.currentTarget));

onAuthStateChanged(auth, async (user) => {
  const authView = el("auth-view");
  const appView = el("app-view");
  if (!user) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await Promise.all([loadProducts(), loadLayout()]);
});
