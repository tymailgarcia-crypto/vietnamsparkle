import {
  auth,
  collection,
  db,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  query,
  serverTimestamp,
  setDoc,
  signOut,
  updateDoc,
  where,
  writeBatch
} from "./firebaseClient.js";
import { mapsApiKey } from "./firebaseWebConfig.js";
import {
  buildCustomerId,
  buildOrderId,
  computeOrderTotals,
  escapeHtml,
  mergeThresholds,
  normalizePhone,
  paymentStatusFor,
  productCategoryKey,
  requireRole,
  THRESHOLD_DEFAULTS,
  todayKey,
  withSubmitLock
} from "./shared.js";

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  unit: "Units (accessories)"
};

function humanizeContainerType(key) {
  if (!key) return "Other";
  return CONTAINER_LABELS[key] || String(key).replace(/_/g, " ");
}

const state = {
  drivers: [],
  containerTypes: [],
  mapsReady: false,
  geocoder: null
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message, isError = false) {
  const node = el("save-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function setWarehouseStatus(message, isError = false) {
  const node = el("warehouse-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function populateForm(settings) {
  el("business-name").value = settings.businessName || "";
  el("legal-name").value = settings.legalName || "";
  el("tax-code").value = settings.taxCode || "";
  el("registered-address").value = settings.registeredAddress || "";
  const contact = settings.contact || {};
  el("whatsapp-url").value = contact.whatsapp || "";
  el("zalo-url").value = contact.zalo || "";
  el("facebook-url").value = contact.facebook || "";
  el("public-phone").value = contact.phone || "";
  el("public-email").value = contact.email || "";
  const bank = settings.bank || {};
  el("bank-account-name").value = bank.accountName || "";
  el("bank-account-number").value = bank.accountNumber || "";
  el("bank-name").value = bank.name || "";
  el("bank-bin").value = bank.bin || "";
  const warehouse = settings.warehouse || {};
  el("warehouse-address").value = warehouse.address || "";
  renderWarehouseCoords(warehouse.location);
  // Thresholds: only pre-fill inputs when the saved value differs from the
  // default, so leaving an input blank keeps the default in effect on save.
  const savedThresholds = (settings.thresholds && typeof settings.thresholds === "object") ? settings.thresholds : {};
  const setThreshold = (id, key) => {
    const raw = savedThresholds[key];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      el(id).value = String(parsed);
    } else {
      el(id).value = "";
    }
  };
  setThreshold("threshold-follow-up-days", "followUpDays");
  setThreshold("threshold-receivable-overdue-days", "receivableOverdueDays");
  setThreshold("threshold-deposit-warning-days", "depositWarningDays");
  setThreshold("threshold-deposit-forfeit-days", "depositForfeitDays");
}

function renderWarehouseCoords(location) {
  const node = el("warehouse-coords");
  if (!node) return;
  if (location && typeof location.lat === "number" && typeof location.lng === "number") {
    const geocodedAt = location.geocodedAt ? ` · geocoded ${location.geocodedAt.slice(0, 10)}` : "";
    node.textContent = `Pin: ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}${geocodedAt}`;
  } else {
    node.textContent = "No pin yet — save an address to geocode.";
  }
}

function setThresholdsStatus(message, isError = false) {
  const node = el("thresholds-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

async function saveThresholds(event) {
  event.preventDefault();
  const readInput = (id, defaultValue) => {
    const raw = el(id).value.trim();
    if (raw === "") return defaultValue;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
  };
  const payload = {
    thresholds: {
      followUpDays: readInput("threshold-follow-up-days", THRESHOLD_DEFAULTS.followUpDays),
      receivableOverdueDays: readInput("threshold-receivable-overdue-days", THRESHOLD_DEFAULTS.receivableOverdueDays),
      depositWarningDays: readInput("threshold-deposit-warning-days", THRESHOLD_DEFAULTS.depositWarningDays),
      depositForfeitDays: readInput("threshold-deposit-forfeit-days", THRESHOLD_DEFAULTS.depositForfeitDays)
    },
    updatedAt: serverTimestamp()
  };
  await withSubmitLock(event, async () => {
    setThresholdsStatus("Saving...");
    try {
      await setDoc(doc(db, "settings", "business"), payload, { merge: true });
      setThresholdsStatus("Saved.");
    } catch (error) {
      setThresholdsStatus(error.message || String(error), true);
    }
  });
}

async function loadSettings() {
  setStatus("Loading...");
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    populateForm(settings);
    setStatus("");
  } catch (error) {
    setStatus(`Could not load settings: ${error.message || error}`, true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  setStatus("Saving...");
  await withSubmitLock(event, async () => {
    try {
      const payload = {
        businessName: el("business-name").value.trim() || null,
        legalName: el("legal-name").value.trim() || null,
        taxCode: el("tax-code").value.trim() || null,
        registeredAddress: el("registered-address").value.trim() || null,
        contact: {
          whatsapp: el("whatsapp-url").value.trim() || null,
          zalo: el("zalo-url").value.trim() || null,
          facebook: el("facebook-url").value.trim() || null,
          phone: el("public-phone").value.trim() || null,
          email: el("public-email").value.trim() || null
        },
        bank: {
          accountName: el("bank-account-name").value.trim() || null,
          accountNumber: el("bank-account-number").value.trim() || null,
          name: el("bank-name").value.trim() || null,
          bin: el("bank-bin").value.trim() || null
        },
        updatedAt: serverTimestamp()
      };
      await setDoc(doc(db, "settings", "business"), payload, { merge: true });
      setStatus("Saved.");
    } catch (error) {
      setStatus(error.message || String(error), true);
    }
  });
}

function loadMapsSdk() {
  if (state.mapsReady) return Promise.resolve();
  if (!mapsApiKey) return Promise.reject(new Error("no-api-key"));
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      state.mapsReady = true;
      resolve();
      return;
    }
    const script = document.createElement("script");
    const params = new URLSearchParams({ key: mapsApiKey, v: "weekly" });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      state.mapsReady = true;
      resolve();
    };
    script.onerror = () => reject(new Error("Maps SDK failed to load"));
    document.head.appendChild(script);
  });
}

function geocodeAddress(address) {
  return new Promise((resolve) => {
    if (!state.geocoder) {
      state.geocoder = new google.maps.Geocoder();
    }
    state.geocoder.geocode({ address, region: "vn" }, (results, status) => {
      if (status === "OK" && results && results.length) {
        const loc = results[0].geometry.location;
        resolve({
          lat: loc.lat(),
          lng: loc.lng(),
          formattedAddress: results[0].formatted_address
        });
      } else {
        resolve(null);
      }
    });
  });
}

async function saveWarehouse(event) {
  event.preventDefault();
  const address = el("warehouse-address").value.trim();
  if (!address) {
    setWarehouseStatus("Enter an address first.", true);
    return;
  }
  await withSubmitLock(event, async () => {
    setWarehouseStatus("Loading map SDK...");
    try {
      await loadMapsSdk();
    } catch (error) {
      setWarehouseStatus(`Could not load Maps SDK: ${error.message || error}`, true);
      return;
    }
    setWarehouseStatus("Geocoding address...");
    const result = await geocodeAddress(address);
    if (!result) {
      setWarehouseStatus("Address could not be geocoded. Check spelling or try a nearby landmark.", true);
      return;
    }
    setWarehouseStatus("Saving...");
    try {
      await setDoc(doc(db, "settings", "business"), {
        warehouse: {
          address,
          location: {
            lat: result.lat,
            lng: result.lng,
            formattedAddress: result.formattedAddress,
            geocodedAt: new Date().toISOString()
          }
        },
        updatedAt: serverTimestamp()
      }, { merge: true });
      renderWarehouseCoords({
        lat: result.lat,
        lng: result.lng,
        geocodedAt: new Date().toISOString()
      });
      setWarehouseStatus(`Saved. Pinned at ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}.`);
    } catch (error) {
      setWarehouseStatus(error.message || String(error), true);
    }
  });
}

async function loadDriversAndProducts() {
  const [driversSnap, productsSnap] = await Promise.all([
    getDocs(collection(db, "drivers")),
    getDocs(collection(db, "products"))
  ]);
  state.drivers = driversSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.active !== false);
  const typesFromProducts = productsSnap.docs
    .map((d) => d.data().containerType)
    .filter((t) => t && t !== "mixed");
  // Order labeled types first (glass_crate, 18_9l_jug, ...) so cards read
  // consistently across drivers, then any product type without a friendly
  // label. Dedupe.
  const labeledOrder = Object.keys(CONTAINER_LABELS);
  const known = labeledOrder.filter((t) => typesFromProducts.includes(t));
  const unknown = typesFromProducts.filter((t) => !labeledOrder.includes(t));
  const seen = new Set();
  state.containerTypes = [...known, ...unknown].filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

function renderDrivers() {
  const container = el("drivers-list");
  const empty = el("drivers-empty");
  if (!container) return;
  if (!state.drivers.length) {
    container.innerHTML = "";
    if (empty) empty.style.display = "";
    return;
  }
  if (empty) empty.style.display = "none";
  container.innerHTML = state.drivers.map((driver) => {
    const loadout = driver.standardLoadout || {};
    const inputs = state.containerTypes.map((type) => `
      <label style="display:flex;flex-direction:column;gap:4px;min-width:110px">
        <span class="muted" style="font-size:12px">${escapeHtml(humanizeContainerType(type))}</span>
        <input
          type="number"
          min="0"
          step="1"
          data-driver-id="${escapeHtml(driver.id)}"
          data-container-type="${escapeHtml(type)}"
          value="${Number(loadout[type] || 0)}"
          style="width:110px"
        >
      </label>
    `).join("");
    return `
      <div class="card" data-driver-card="${escapeHtml(driver.id)}">
        <div class="order-top">
          <div>
            <strong>${escapeHtml(driver.driverName || driver.id)}</strong>
            <div class="muted" style="font-size:12px">${escapeHtml(driver.phone || "")}</div>
          </div>
          <div class="button-row" style="gap:8px">
            <button class="primary" type="button" data-save-loadout="${escapeHtml(driver.id)}">Save loadout</button>
            <span class="muted" data-loadout-status="${escapeHtml(driver.id)}"></span>
          </div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px">
          ${inputs}
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll("[data-save-loadout]").forEach((button) => {
    button.addEventListener("click", saveDriverLoadout);
  });
}

async function saveDriverLoadout(event) {
  const button = event.currentTarget;
  const driverId = button.dataset.saveLoadout;
  if (!driverId) return;
  const statusNode = document.querySelector(`[data-loadout-status="${CSS.escape(driverId)}"]`);
  const setLoadoutStatus = (message, isError = false) => {
    if (!statusNode) return;
    statusNode.textContent = message || "";
    statusNode.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
  };
  const inputs = document.querySelectorAll(`input[data-driver-id="${CSS.escape(driverId)}"]`);
  const loadout = {};
  inputs.forEach((input) => {
    const type = input.dataset.containerType;
    const value = Math.max(0, Math.floor(Number(input.value) || 0));
    if (type) loadout[type] = value;
  });
  await withSubmitLock(button, async () => {
    setLoadoutStatus("Saving...");
    try {
      await updateDoc(doc(db, "drivers", driverId), {
        standardLoadout: loadout,
        updatedAt: serverTimestamp()
      });
      const driver = state.drivers.find((d) => d.id === driverId);
      if (driver) driver.standardLoadout = loadout;
      setLoadoutStatus("Saved.");
    } catch (error) {
      setLoadoutStatus(error.message || String(error), true);
    }
  });
}

// Fixed set of Da Nang addresses used for owner-only test data. Phone numbers
// live in a reserved 0999* range so buildCustomerId() produces test IDs that
// can never collide with a real customer. Every doc written from populate is
// tagged `testFixture: true` so cleanup can find and delete it without ever
// touching real records.
const TEST_ADDRESS_FIXTURES = [
  { name: "Nguyễn Thị Hoa",  phone: "0999000101", address: "58 Lê Quang Đạo, Ngũ Hành Sơn, Đà Nẵng 550000, Vietnam" },
  { name: "Trần Văn Bình",   phone: "0999000102", address: "Đảo Xanh 3, Hòa Cường, Đà Nẵng 550000, Vietnam" },
  { name: "Lê Minh Anh",     phone: "0999000103", address: "90 Hùng Vương, Hải Châu, Đà Nẵng 550000, Vietnam" },
  { name: "Phạm Quốc Đạt",   phone: "0999000104", address: "Lô 10 Trần Nhân Tông, Sơn Trà, Đà Nẵng, Vietnam" },
  { name: "Hoàng Thị Lan",   phone: "0999000105", address: "Tổ 11, Phường Tam Thuận, Quận Thanh Khê, Đà Nẵng, Vietnam" },
  { name: "Đỗ Thanh Sơn",    phone: "0999000106", address: "123 Nguyễn Văn Linh, Thanh Khê Đông, Đà Nẵng, Vietnam" },
  { name: "Vũ Ngọc Mai",     phone: "0999000107", address: "52 Bạch Đằng, Hải Châu 1, Đà Nẵng, Vietnam" },
  { name: "Ngô Hữu Nam",     phone: "0999000108", address: "217 Nguyễn Công Trứ, An Hải Bắc, Sơn Trà, Đà Nẵng, Vietnam" }
];

function setTestDataStatus(message, isError = false) {
  const node = el("test-data-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function setTestDataSummary(message) {
  const node = el("test-data-summary");
  if (node) node.textContent = message || "";
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function loadProductsForFixtures() {
  const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
  const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const crates = products.filter((p) => productCategoryKey(p) === "glass");
  const jugs = products.filter((p) => productCategoryKey(p) === "jug");
  return { crates, jugs };
}

function fixtureItemsFor(crates, jugs) {
  const items = [];
  const crateCount = randomInt(1, 3);
  const jugCount = randomInt(1, 2);
  if (crates.length) {
    const crate = pickRandom(crates);
    items.push({ product: crate, quantity: crateCount });
  }
  if (jugs.length) {
    const jug = pickRandom(jugs);
    items.push({ product: jug, quantity: jugCount });
  }
  return items;
}

async function populateTestOrders(event) {
  await withSubmitLock(event, async () => {
    setTestDataStatus("Loading product catalog...");
    setTestDataSummary("");
    let crates, jugs;
    try {
      ({ crates, jugs } = await loadProductsForFixtures());
    } catch (error) {
      setTestDataStatus(`Could not load products: ${error.message || error}`, true);
      return;
    }
    if (!crates.length || !jugs.length) {
      setTestDataStatus("Need at least one active crate product and one jug product before seeding.", true);
      return;
    }

    const today = todayKey();
    const notesTag = `[test order ${today}]`;
    let createdCustomers = 0;
    let createdOrders = 0;
    const failures = [];

    for (const fixture of TEST_ADDRESS_FIXTURES) {
      const customerId = buildCustomerId(fixture.phone);
      if (!customerId) {
        failures.push(`${fixture.name} (bad phone)`);
        continue;
      }
      const lines = fixtureItemsFor(crates, jugs).map((entry) => ({
        productId: entry.product.id,
        productName: entry.product.productName,
        quantity: entry.quantity,
        unitPrice: Number(entry.product.unitPrice || 0),
        defaultDepositAmount: Number(entry.product.defaultDepositAmount || 0)
      }));
      if (!lines.length) {
        failures.push(`${fixture.name} (no items)`);
        continue;
      }
      const totals = computeOrderTotals(lines);
      const amountDue = totals.subtotal + totals.depositTotal;
      const orderId = buildOrderId("TEST");
      const nowIso = new Date().toISOString();

      let customerExists = false;
      try {
        const existingSnap = await getDoc(doc(db, "customers", customerId));
        customerExists = existingSnap.exists();
      } catch (error) {
        failures.push(`${fixture.name}: ${error.message || error}`);
        continue;
      }

      try {
        const batch = writeBatch(db);
        // First populate for this fixture creates the customer profile.
        // Subsequent populates only add new orders — leave the customer doc
        // alone so orderCount / createdAt / any manual edits survive.
        if (!customerExists) {
          batch.set(doc(db, "customers", customerId), {
            name: fixture.name,
            billingName: null,
            phone: normalizePhone(fixture.phone),
            secondaryPhone: null,
            taxId: null,
            address: fixture.address,
            area: null,
            addressHistory: fixture.address,
            notes: `${notesTag} test address customer for populate/delete tooling`,
            lastSourceChannel: "test_fixture",
            lastOrderAt: today,
            orderCount: 0,
            testFixture: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          createdCustomers += 1;
        }

        batch.set(doc(db, "orders", orderId), {
          createdAt: nowIso,
          createdAtServer: serverTimestamp(),
          sourceChannel: "test_fixture",
          customerId,
          customerName: fixture.name,
          phone: normalizePhone(fixture.phone),
          email: null,
          authUid: null,
          address: fixture.address,
          deliveryLocation: null,
          deliveryDate: today,
          deliveryWindow: "",
          assignedDriverId: null,
          status: "pending_approval",
          subtotal: totals.subtotal,
          depositTotal: totals.depositTotal,
          amountPaid: 0,
          balanceDue: amountDue,
          paymentStatus: paymentStatusFor(0, amountDue),
          notes: `${notesTag} ${lines.map((l) => `${l.quantity}× ${l.productName}`).join(", ")}`,
          testFixture: true,
          updatedAt: nowIso
        });

        lines.forEach((line) => {
          const itemId = buildOrderId("ITEM");
          batch.set(doc(db, "orderItems", itemId), {
            orderId,
            authUid: null,
            productId: line.productId,
            productName: line.productName,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.unitPrice * line.quantity,
            testFixture: true
          });
        });

        await batch.commit();
        createdOrders += 1;
      } catch (error) {
        failures.push(`${fixture.name}: ${error.message || error}`);
      }
    }

    const newCustomerNote = createdCustomers
      ? ` and ${createdCustomers} new test customer profile${createdCustomers === 1 ? "" : "s"}`
      : "";
    if (failures.length) {
      setTestDataStatus(`Added ${createdOrders} order${createdOrders === 1 ? "" : "s"}${newCustomerNote}, with ${failures.length} failure(s).`, true);
      setTestDataSummary(`Failures: ${failures.join(" | ")}`);
    } else {
      setTestDataStatus(`Added ${createdOrders} test order${createdOrders === 1 ? "" : "s"}${newCustomerNote} for ${today}.`);
      setTestDataSummary(`Tagged notes: "${notesTag}". Look for them on the today board or the map view.`);
    }
  }, { busyLabel: "Seeding..." });
}

async function deleteTestOrders(event) {
  await withSubmitLock(event, async () => {
    setTestDataStatus("Scanning for test fixtures...");
    setTestDataSummary("");

    const collectionsToClean = ["orderItems", "orders", "depositEvents", "payments", "customers"];
    const stats = {};
    let anyError = null;

    for (const name of collectionsToClean) {
      try {
        const snap = await getDocs(query(collection(db, name), where("testFixture", "==", true)));
        // Firestore batches are capped at 500 writes — chunk defensively even
        // though the fixture list is small today, in case someone runs
        // populate multiple times before deleting.
        const chunks = [];
        for (let i = 0; i < snap.docs.length; i += 400) {
          chunks.push(snap.docs.slice(i, i + 400));
        }
        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
        stats[name] = snap.size;
      } catch (error) {
        anyError = error;
        stats[name] = `err: ${error.message || error}`;
      }
    }

    const summaryParts = Object.keys(stats).map((k) => `${k}: ${stats[k]}`);
    if (anyError) {
      setTestDataStatus(`Cleanup finished with errors: ${anyError.message || anyError}`, true);
    } else {
      setTestDataStatus("Deleted all test fixtures.");
    }
    setTestDataSummary(summaryParts.join(" · "));
  }, { busyLabel: "Deleting..." });
}

el("settings-form").addEventListener("submit", saveSettings);
const thresholdsForm = el("thresholds-form");
if (thresholdsForm) thresholdsForm.addEventListener("submit", saveThresholds);
el("warehouse-form").addEventListener("submit", saveWarehouse);
el("populate-test-orders").addEventListener("click", populateTestOrders);
el("delete-test-orders").addEventListener("click", deleteTestOrders);
el("logout-button").addEventListener("click", async () => {
  await signOut(auth);
});

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
  await loadSettings();
  try {
    await loadDriversAndProducts();
    renderDrivers();
  } catch (error) {
    console.error("Could not load drivers/products:", error);
  }
});
