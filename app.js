import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://gcnrgrmmsajatoblhvfb.supabase.co";
const SUPABASE_KEY = "sb_publishable_xJEAhbN_R2NOT7jutamerA_hJCZzvb_";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (id) => document.getElementById(id);
const state = { user: null, profile: null, targets: null, meals: [], weights: [], photo: null };

/* =======================================================================
   MACROBEREKENING
   -----------------------------------------------------------------------
   Ruststofwisseling volgens Mifflin-St Jeor. Daar bovenop tellen we
   dagelijkse activiteit en trainingen apart op, in plaats van de gebruikelijke
   grove multiplier. Die standaardtabel ("matig actief = 1,55") overschat
   het verbruik van veel mensen met een kantoorbaan die drie keer per week
   sporten, waardoor het tekort op papier wel klopt maar in de praktijk niet.
   ======================================================================= */

const DAILY_BASE = {
  sedentary: 1.20,
  light: 1.28,
  moderate: 1.38,
  active: 1.48,
  very_active: 1.58,
};

// Toeslag op de multiplier per training per week.
const SESSION_COST = { light: 0.022, moderate: 0.038, intense: 0.055 };

// Eiwit per kilo, opgebouwd uit hoe vaak en hoe zwaar er getraind wordt.
const PROTEIN_BY_DAYS = [1.4, 1.4, 1.6, 1.6, 1.8, 1.8, 2.0, 2.0];
const PROTEIN_BY_INTENSITY = { light: -0.15, moderate: 0, intense: 0.20 };
const PROTEIN_BY_TYPE = { cardio: -0.05, mixed: 0, strength: 0.10 };

function computeTargets(p, weightKg) {
  const bmr = p.gender === "male"
    ? 10 * weightKg + 6.25 * p.height_cm - 5 * p.age_years + 5
    : 10 * weightKg + 6.25 * p.height_cm - 5 * p.age_years - 161;

  const days = Math.min(p.training_days_per_week ?? 0, 7);
  const multiplier = Math.min(
    (DAILY_BASE[p.activity_level] ?? 1.28) + days * (SESSION_COST[p.training_intensity] ?? 0.038),
    1.95
  );
  const tdee = bmr * multiplier;

  // 1 kg vetweefsel is ruwweg 7700 kcal.
  const rate = p.goal_rate_kg_per_week ?? 0.5;
  let target = tdee - (rate * 7700) / 7;

  // Ondergrens: nooit onder je ruststofwisseling, en nooit onder een absolute
  // bodem. Wie structureel onder zijn BMR eet, verliest vooral spiermassa.
  const floor = Math.max(bmr, p.gender === "male" ? 1500 : 1200);
  const floored = target < floor;
  if (floored) target = floor;

  // Eiwit: hoe vaker en hoe zwaarder je traint, hoe meer je nodig hebt om
  // spiermassa vast te houden in een tekort.
  // Wie niet traint, heeft geen intensiteit — die toeslagen slaan we dan over.
  let perKg = PROTEIN_BY_DAYS[days];
  if (days > 0) {
    perKg += (PROTEIN_BY_INTENSITY[p.training_intensity] ?? 0)
      + (PROTEIN_BY_TYPE[p.training_type ?? "mixed"] ?? 0);
  }
  perKg = Math.min(Math.max(perKg, 1.4), 2.4);

  // Rekenen over streefgewicht als dat lager is: 2 g/kg over 110 kg zou
  // 220 g eiwit betekenen en dat eet niemand vol.
  const useGoal = p.goal_weight_kg && p.goal_weight_kg < weightKg;
  const basis = useGoal ? Number(p.goal_weight_kg) : weightKg;

  const protein = perKg * basis;
  let fat = Math.max(0.8 * basis, (target * 0.22) / 9);
  let carbs = (target - protein * 4 - fat * 9) / 4;

  // Als er te weinig ruimte overblijft, knijpen we eerst het vet af tot 0,6 g/kg.
  if (carbs < 60) {
    fat = Math.max(0.6 * basis, fat - ((60 - carbs) * 4) / 9);
    carbs = Math.max((target - protein * 4 - fat * 9) / 4, 40);
  }

  return {
    bmr_kcal: round(bmr, 1),
    tdee_kcal: round(tdee, 1),
    calorie_target: round(target, 0),
    protein_g: round(protein, 1),
    carbs_g: round(carbs, 1),
    fat_g: round(fat, 1),
    protein_per_kg: round(perKg, 2),
    protein_basis: useGoal ? "goal_weight" : "current_weight",
    basis_weight_kg: round(basis, 2),
    training_days_per_week: days,
    training_intensity: p.training_intensity,
    formula: "mifflin_st_jeor",
    floored,
    multiplier: round(multiplier, 3),
  };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/* ======================= HULPJES ======================= */

function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
  $("screen-" + name)?.classList.add("on");
  document.querySelectorAll("#nav button").forEach((b) =>
    b.classList.toggle("on", b.dataset.screen === name)
  );
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function fail(id, text) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !text;
}

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, lokale tijd

/* ======================= INLOGGEN ======================= */

let authMode = "signin";

$("auth-toggle").addEventListener("click", () => {
  authMode = authMode === "signin" ? "signup" : "signin";
  $("auth-submit").textContent = authMode === "signin" ? "Inloggen" : "Account aanmaken";
  $("auth-toggle").textContent =
    authMode === "signin" ? "Nog geen account? Aanmelden" : "Heb je al een account? Inloggen";
  $("auth-password").autocomplete = authMode === "signin" ? "current-password" : "new-password";
  fail("auth-error", "");
  $("auth-notice").hidden = true;
});

$("form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("auth-error", "");
  $("auth-notice").hidden = true;

  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;

  if (!email) return fail("auth-error", "Vul je e-mailadres in.");
  if (password.length < 8) return fail("auth-error", "Je wachtwoord moet minstens 8 tekens hebben.");

  $("auth-submit").disabled = true;
  try {
    if (authMode === "signup") {
      const { data, error } = await db.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        $("auth-notice").textContent =
          "Check je mail en bevestig je adres. Daarna kun je inloggen.";
        $("auth-notice").hidden = false;
        return;
      }
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    fail("auth-error", translateAuthError(err));
  } finally {
    $("auth-submit").disabled = false;
  }
});

function translateAuthError(err) {
  const m = (err?.message || "").toLowerCase();
  if (m.includes("invalid login")) return "E-mailadres of wachtwoord klopt niet.";
  if (m.includes("already registered")) return "Dit adres heeft al een account. Log in.";
  if (m.includes("email not confirmed")) return "Bevestig eerst je e-mailadres via de link in je mail.";
  if (m.includes("rate limit")) return "Te veel pogingen. Wacht even en probeer opnieuw.";
  return err?.message || "Er ging iets mis. Probeer het opnieuw.";
}

$("sign-out").addEventListener("click", async () => {
  await db.auth.signOut();
});

/* ======================= PROFIEL ======================= */

function pickerValue(id) {
  return $(id).querySelector("button.on")?.dataset.value;
}

function bindPicker(id) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $(id).querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b === btn);
      b.setAttribute("aria-checked", b === btn ? "true" : "false");
    });
    previewTargets();
  });
}
bindPicker("p-intensity");
bindPicker("p-type");

$("p-days").addEventListener("input", (e) => {
  $("p-days-out").textContent = e.target.value;
  previewTargets();
});
["p-gender", "p-age", "p-height", "p-weight", "p-goal-weight", "p-rate", "p-activity"].forEach((id) =>
  $(id).addEventListener("input", previewTargets)
);

function readProfileForm() {
  return {
    gender: $("p-gender").value,
    age_years: parseInt($("p-age").value, 10),
    height_cm: parseFloat($("p-height").value),
    goal_weight_kg: parseFloat($("p-goal-weight").value) || null,
    goal_rate_kg_per_week: parseFloat($("p-rate").value),
    activity_level: $("p-activity").value,
    training_days_per_week: parseInt($("p-days").value, 10),
    training_intensity: pickerValue("p-intensity"),
    training_type: pickerValue("p-type"),
  };
}

function previewTargets() {
  const p = readProfileForm();
  const weight = parseFloat($("p-weight").value);
  if (!p.age_years || !p.height_cm || !weight) {
    $("preview").hidden = true;
    return;
  }
  const t = computeTargets(p, weight);
  $("pv-kcal").textContent = Math.round(t.calorie_target).toLocaleString("nl-NL");
  $("pv-p").textContent = Math.round(t.protein_g);
  $("pv-c").textContent = Math.round(t.carbs_g);
  $("pv-f").textContent = Math.round(t.fat_g);

  const parts = [
    `${t.protein_per_kg} g eiwit per kilo, op basis van ${p.training_days_per_week}× per week ${
      { light: "rustig", moderate: "stevig", intense: "zwaar" }[p.training_intensity]
    } trainen.`,
  ];
  if (t.protein_basis === "goal_weight") parts.push("Gerekend over je streefgewicht.");
  if (t.floored)
    parts.push("Je gekozen tempo zou onder een verantwoorde ondergrens uitkomen, dus we houden het hierop.");
  $("pv-note").textContent = parts.join(" ");
  $("preview").hidden = false;
}

$("form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("profile-error", "");

  const p = readProfileForm();
  const weight = parseFloat($("p-weight").value);

  if (!p.age_years) return fail("profile-error", "Vul je leeftijd in.");
  if (!p.height_cm) return fail("profile-error", "Vul je lengte in.");
  if (!weight) return fail("profile-error", "Vul je huidige gewicht in.");
  if (p.goal_weight_kg && p.goal_weight_kg > weight)
    return fail("profile-error", "Je streefgewicht ligt boven je huidige gewicht. Deze app rekent op afvallen.");

  $("profile-submit").disabled = true;
  try {
    const { error: pe } = await db.from("profiles").upsert({ id: state.user.id, ...p });
    if (pe) throw pe;

    const { error: we } = await db
      .from("weight_logs")
      .upsert({ user_id: state.user.id, weight_kg: weight, logged_on: today() }, { onConflict: "user_id,logged_on" });
    if (we) throw we;

    const t = computeTargets(p, weight);
    delete t.floored;
    delete t.multiplier;
    const { error: te } = await db
      .from("macro_targets")
      .upsert({ user_id: state.user.id, effective_from: today(), ...t }, { onConflict: "user_id,effective_from" });
    if (te) throw te;

    await loadAll();
    show("today");
    toast("Doelen opgeslagen");
  } catch (err) {
    fail("profile-error", err.message || "Opslaan lukte niet.");
  } finally {
    $("profile-submit").disabled = false;
  }
});

$("edit-profile").addEventListener("click", () => {
  fillProfileForm();
  show("onboarding");
});

function fillProfileForm() {
  const p = state.profile;
  if (!p) return;
  $("p-gender").value = p.gender;
  $("p-age").value = p.age_years ?? "";
  $("p-height").value = p.height_cm ?? "";
  $("p-weight").value = state.weights[0]?.weight_kg ?? "";
  $("p-goal-weight").value = p.goal_weight_kg ?? "";
  $("p-rate").value = p.goal_rate_kg_per_week ?? 0.5;
  $("p-activity").value = p.activity_level;
  $("p-days").value = p.training_days_per_week ?? 3;
  $("p-days-out").textContent = p.training_days_per_week ?? 3;
  ["p-intensity", "p-type"].forEach((id) => {
    const val = id === "p-intensity" ? p.training_intensity : p.training_type;
    $(id).querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.value === val);
      b.setAttribute("aria-checked", b.dataset.value === val ? "true" : "false");
    });
  });
  previewTargets();
}

/* ======================= FOTO EN ANALYSE ======================= */

$("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const shrunk = await shrink(file);
  state.photo = shrunk;
  $("photo-preview").src = shrunk.dataUrl;
  $("photo-preview").hidden = false;
  $("add-step-photo").hidden = true;
  $("add-step-review").hidden = false;
  analyse(shrunk.base64);
});

$("skip-photo").addEventListener("click", () => {
  state.photo = null;
  $("photo-preview").hidden = true;
  $("add-step-photo").hidden = true;
  $("add-step-review").hidden = false;
  $("m-name").focus();
});

// Verkleinen scheelt uploadtijd, kosten en accugebruik. 1024px is ruim
// genoeg om een bord eten te herkennen.
function shrink(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ blob, dataUrl: reader.result, base64: reader.result.split(",")[1] });
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        0.82
      );
    };
    img.onerror = () => reject(new Error("Deze afbeelding kon niet geopend worden."));
    img.src = url;
  });
}

async function analyse(base64) {
  $("analysing").hidden = false;
  $("meal-submit").disabled = true;
  fail("meal-error", "");
  $("confidence").hidden = true;

  try {
    const { data: { session } } = await db.auth.getSession();
    let token = session?.access_token;

    if (!token) {
      // Sessie verlopen of kwijt. Eén poging tot verversen voordat we opgeven,
      // zodat je niet onnodig opnieuw hoeft in te loggen.
      const { data: refreshed } = await db.auth.refreshSession();
      token = refreshed?.session?.access_token;
    }
    if (!token) {
      throw new Error("Je sessie is verlopen. Log opnieuw in om de analyse te gebruiken.");
    }

    const res = await fetch("/api/analyze-meal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ image: base64 }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Analyse mislukt.");
    const meal = await res.json();

    $("m-name").value = meal.name ?? "";
    $("m-kcal").value = Math.round(meal.calories ?? 0);
    $("m-protein").value = round(meal.protein_g ?? 0, 1);
    $("m-carbs").value = round(meal.carbs_g ?? 0, 1);
    $("m-fat").value = round(meal.fat_g ?? 0, 1);
    if (meal.meal_type) $("m-type").value = meal.meal_type;
    state.analysis = meal;

    const note =
      meal.confidence === "high"
        ? "Duidelijk bord. Loop de cijfers toch even na."
        : meal.confidence === "medium"
        ? "Redelijke schatting. Portiegrootte is op foto lastig te zien — pas aan als je meer at."
        : "Lastig te beoordelen. Behandel dit als een ruwe gok en corrigeer wat je weet.";
    $("confidence").textContent = meal.notes ? `${note} ${meal.notes}` : note;
    $("confidence").hidden = false;
  } catch (err) {
    const verlopen = /sessie is verlopen/i.test(err.message || "");
    fail("meal-error", verlopen ? err.message : `${err.message} Vul de waarden zelf in.`);
  } finally {
    $("analysing").hidden = true;
    $("meal-submit").disabled = false;
  }
}

$("meal-cancel").addEventListener("click", resetAddScreen);

function resetAddScreen() {
  $("form-meal").reset();
  $("photo-input").value = "";
  $("add-step-review").hidden = true;
  $("add-step-photo").hidden = false;
  $("confidence").hidden = true;
  fail("meal-error", "");
  state.photo = null;
  state.analysis = null;
}

$("form-meal").addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("meal-error", "");

  const name = $("m-name").value.trim();
  const kcal = parseFloat($("m-kcal").value);
  if (!name) return fail("meal-error", "Geef de maaltijd een naam.");
  if (!(kcal >= 0)) return fail("meal-error", "Vul het aantal calorieën in.");

  $("meal-submit").disabled = true;
  try {
    let photo_path = null;
    if (state.photo) {
      photo_path = `${state.user.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await db.storage
        .from("meal-photos")
        .upload(photo_path, state.photo.blob, { contentType: "image/jpeg" });
      if (error) throw error;
    }

    const corrected =
      state.analysis && Math.abs((state.analysis.calories ?? 0) - kcal) > 1;

    const { error } = await db.from("meals").insert({
      user_id: state.user.id,
      name,
      meal_type: $("m-type").value,
      photo_path,
      calories: kcal,
      protein_g: parseFloat($("m-protein").value) || 0,
      carbs_g: parseFloat($("m-carbs").value) || 0,
      fat_g: parseFloat($("m-fat").value) || 0,
      source: state.photo ? "photo_ai" : "manual",
      analysis_confidence: state.analysis?.confidence ?? null,
      analysis_raw: state.analysis ?? null,
      user_corrected: !!corrected,
      eaten_at: new Date().toISOString(),
      eaten_on: today(),
    });
    if (error) throw error;

    resetAddScreen();
    await loadMeals();
    renderToday();
    show("today");
    toast("Opgeslagen");
  } catch (err) {
    fail("meal-error", err.message || "Opslaan lukte niet.");
  } finally {
    $("meal-submit").disabled = false;
  }
});

/* ======================= GEWICHT ======================= */

$("form-weight").addEventListener("submit", async (e) => {
  e.preventDefault();
  fail("weight-error", "");
  const value = parseFloat($("w-value").value);
  if (!value || value < 30 || value > 400) return fail("weight-error", "Vul een gewicht tussen 30 en 400 kg in.");

  try {
    const { error } = await db
      .from("weight_logs")
      .upsert({ user_id: state.user.id, weight_kg: value, logged_on: today() }, { onConflict: "user_id,logged_on" });
    if (error) throw error;

    // Doelen meebewegen: bij een fors gewijzigd gewicht klopt het oude budget niet meer.
    const t = computeTargets(state.profile, value);
    delete t.floored;
    delete t.multiplier;
    await db
      .from("macro_targets")
      .upsert({ user_id: state.user.id, effective_from: today(), ...t }, { onConflict: "user_id,effective_from" });

    $("w-value").value = "";
    await loadAll();
    renderProgress();
    toast("Gewicht opgeslagen");
  } catch (err) {
    fail("weight-error", err.message || "Opslaan lukte niet.");
  }
});

/* ======================= DATA LADEN ======================= */

async function loadAll() {
  const [profile, targets, weights] = await Promise.all([
    db.from("profiles").select("*").eq("id", state.user.id).maybeSingle(),
    db.from("macro_targets").select("*").order("effective_from", { ascending: false }).limit(1).maybeSingle(),
    db.from("weight_logs").select("*").order("logged_on", { ascending: false }).limit(60),
  ]);
  state.profile = profile.data;
  state.targets = targets.data;
  state.weights = weights.data ?? [];
  await loadMeals();
}

async function loadMeals() {
  const { data } = await db
    .from("meals")
    .select("*")
    .gte("eaten_on", daysAgo(6))
    .order("eaten_at", { ascending: false });
  state.meals = data ?? [];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE");
}

/* ======================= VANDAAG TEKENEN ======================= */

const MACRO_COLORS = { protein: "#1F5F8B", carbs: "#C08A2E", fat: "#8E4B6B" };

function renderToday() {
  const t = state.targets;
  const meals = state.meals.filter((m) => m.eaten_on === today());

  const sum = meals.reduce(
    (a, m) => ({
      kcal: a.kcal + Number(m.calories),
      p: a.p + Number(m.protein_g),
      c: a.c + Number(m.carbs_g),
      f: a.f + Number(m.fat_g),
    }),
    { kcal: 0, p: 0, c: 0, f: 0 }
  );

  const budget = Number(t?.calorie_target ?? 0);
  const left = budget - sum.kcal;

  $("today-date").textContent = new Date().toLocaleDateString("nl-NL", {
    weekday: "long", day: "numeric", month: "long",
  });
  $("budget-num").textContent = Math.abs(Math.round(left)).toLocaleString("nl-NL");
  $("budget-word").textContent = left < 0 ? "te veel" : "over";
  $("screen-today").classList.toggle("over", left < 0);
  $("budget-sub").textContent =
    `${Math.round(sum.kcal).toLocaleString("nl-NL")} van ${Math.round(budget).toLocaleString("nl-NL")} kcal gegeten` +
    (left < 0 ? ". Eén dag boven je budget maakt je week niet stuk." : "");

  // Ledger: elke maaltijd is een segment, in de volgorde waarin je hem at.
  const ledger = $("ledger");
  ledger.innerHTML = "";
  const chrono = [...meals].reverse();
  chrono.forEach((m, i) => {
    const span = document.createElement("span");
    span.style.width = `${Math.min((Number(m.calories) / budget) * 100, 100)}%`;
    span.style.background = shade(i);
    ledger.appendChild(span);
  });
  const rest = document.createElement("span");
  rest.className = "rest";
  ledger.appendChild(rest);
  $("ledger-key").textContent = meals.length
    ? `${meals.length} ${meals.length === 1 ? "maaltijd" : "maaltijden"}, oudste links.`
    : "Nog niets gelogd vandaag.";

  // Macro's
  $("macros").innerHTML = [
    macroLine("Eiwit", sum.p, t?.protein_g, MACRO_COLORS.protein),
    macroLine("Koolhydraten", sum.c, t?.carbs_g, MACRO_COLORS.carbs),
    macroLine("Vet", sum.f, t?.fat_g, MACRO_COLORS.fat),
  ].join("");

  // Maaltijden
  const list = $("meals-list");
  $("meals-count").textContent = meals.length ? `${Math.round(sum.kcal)} kcal` : "";
  if (!meals.length) {
    list.innerHTML = `<p class="empty">Fotografeer je eerste maaltijd via de knop onderin.</p>`;
    return;
  }
  list.innerHTML = meals
    .map(
      (m) => `
      <div class="meal">
        ${m.photo_path ? `<img class="meal-thumb" data-path="${m.photo_path}" alt="">` : `<div class="meal-thumb"></div>`}
        <div class="meal-body">
          <div class="meal-name">${escapeHtml(m.name)}</div>
          <div class="meal-meta">${fmtTime(m.eaten_at)} · E ${Math.round(m.protein_g)} · K ${Math.round(m.carbs_g)} · V ${Math.round(m.fat_g)}</div>
        </div>
        <div style="text-align:right">
          <div class="meal-kcal">${Math.round(m.calories)}</div>
          <button class="meal-del" data-id="${m.id}">wissen</button>
        </div>
      </div>`
    )
    .join("");

  list.querySelectorAll("img[data-path]").forEach(async (img) => {
    const { data } = await db.storage.from("meal-photos").createSignedUrl(img.dataset.path, 3600);
    if (data?.signedUrl) img.src = data.signedUrl;
  });

  list.querySelectorAll(".meal-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await db.from("meals").delete().eq("id", btn.dataset.id);
      await loadMeals();
      renderToday();
      toast("Maaltijd gewist");
    })
  );
}

function macroLine(label, have, target, color) {
  const t = Number(target ?? 0);
  const pct = t ? Math.min((have / t) * 100, 100) : 0;
  const leftG = Math.round(t - have);
  return `
    <div class="macro-line">
      <div class="macro-top">
        <b>${label}</b>
        <span class="num">${Math.round(have)} / ${Math.round(t)} g${leftG > 0 ? ` · nog ${leftG}` : ""}</span>
      </div>
      <div class="macro-track"><div class="macro-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
}

// Opeenvolgende maaltijden krijgen iets andere tinten, zodat de segmenten
// uit elkaar te houden zijn zonder een legenda.
function shade(i) {
  const tints = ["#2F4F45", "#3E6557", "#4E7B69", "#5F917B", "#71A78D"];
  return tints[i % tints.length];
}

const fmtTime = (iso) =>
  new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ======================= VOORTGANG TEKENEN ======================= */

function renderProgress() {
  const w = [...state.weights].reverse();
  const chart = $("trend-chart");

  if (w.length < 2) {
    chart.classList.remove("on");
    $("trend-empty").hidden = false;
    $("trend-delta").textContent = w.length ? `${w[0].weight_kg} kg` : "";
  } else {
    $("trend-empty").hidden = true;
    chart.classList.add("on");
    const vals = w.map((x) => Number(x.weight_kg));
    const min = Math.min(...vals) - 0.5;
    const max = Math.max(...vals) + 0.5;
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * 320;
      const y = 110 - ((v - min) / (max - min)) * 100;
      return `${round(x, 1)},${round(y, 1)}`;
    });
    const goal = state.profile?.goal_weight_kg;
    const goalY = goal ? 110 - ((goal - min) / (max - min)) * 100 : null;
    chart.innerHTML =
      (goalY !== null && goalY > 0 && goalY < 120
        ? `<line x1="0" y1="${round(goalY, 1)}" x2="320" y2="${round(goalY, 1)}" stroke="#2F6F4E" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`
        : "") +
      `<polyline points="${pts.join(" ")}" fill="none" stroke="#1B2420" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;

    const delta = vals[vals.length - 1] - vals[0];
    $("trend-delta").textContent =
      `${vals[vals.length - 1].toFixed(1)} kg · ${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`;
  }

  // Laatste zeven dagen tegen het budget
  const budget = Number(state.targets?.calorie_target ?? 0);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const date = daysAgo(i);
    const kcal = state.meals
      .filter((m) => m.eaten_on === date)
      .reduce((a, m) => a + Number(m.calories), 0);
    const pct = budget ? Math.min((kcal / budget) * 100, 100) : 0;
    const over = kcal > budget;
    rows.push(`
      <div class="day-row">
        <span class="day-name">${i === 0 ? "Vandaag" : new Date(date).toLocaleDateString("nl-NL", { weekday: "short", day: "numeric" })}</span>
        <span class="day-bar"><span style="width:${pct}%;background:${kcal === 0 ? "#D9DDD4" : over ? "#A93226" : "#2F6F4E"}"></span></span>
        <span class="day-num">${kcal ? Math.round(kcal) : "–"}</span>
      </div>`);
  }
  $("days-list").innerHTML = rows.join("");
}

function renderProfile() {
  $("profile-email").textContent = state.user.email;
  const t = state.targets;
  const p = state.profile;
  if (!t || !p) return;
  const intensity = { light: "rustig", moderate: "stevig", intense: "zwaar" }[p.training_intensity];
  $("targets-summary").innerHTML = `
    <div class="target-row"><span>Dagbudget</span><b>${Math.round(t.calorie_target)} kcal</b></div>
    <div class="target-row"><span>Eiwit</span><b>${Math.round(t.protein_g)} g</b></div>
    <div class="target-row"><span>Koolhydraten</span><b>${Math.round(t.carbs_g)} g</b></div>
    <div class="target-row"><span>Vet</span><b>${Math.round(t.fat_g)} g</b></div>
    <div class="target-row"><span>Onderhoudsniveau</span><b>${Math.round(t.tdee_kcal)} kcal</b></div>
    <div class="target-row"><span>Eiwitfactor</span><b>${t.protein_per_kg} g/kg</b></div>
    <div class="target-row"><span>Training</span><b>${p.training_days_per_week}× ${intensity}</b></div>`;
}

/* ======================= NAVIGATIE ======================= */

$("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const screen = btn.dataset.screen;

  // Eerst wisselen, dan pas tekenen. Andersom blijft de knop dood aanvoelen
  // zodra er in het tekenen iets misgaat.
  show(screen);

  try {
    if (screen === "today") renderToday();
    if (screen === "progress") renderProgress();
    if (screen === "profile") renderProfile();
    if (screen === "add") resetAddScreen();
  } catch (err) {
    console.error("Tekenen van scherm mislukte:", screen, err);
  }
});

/* ======================= START ======================= */

// Supabase houdt tijdens deze callback een interne vergrendeling vast. Andere
// Supabase-aanroepen hierbinnen afwachten kan blijven hangen, waardoor de app
// halverwege blijft staan. Daarom zetten we het echte werk buiten de callback.
db.auth.onAuthStateChange((_event, session) => {
  state.user = session?.user ?? null;
  setTimeout(() => naAuthWijziging(), 0);
});

async function naAuthWijziging() {
  $("boot").hidden = true;

  if (!state.user) {
    $("nav").hidden = true;
    show("auth");
    return;
  }

  try {
    await loadAll();
  } catch (err) {
    // Zonder profiel kan de app niets tonen, dus melden we het in plaats van
    // op een leeg scherm te blijven staan.
    console.error(err);
    fail("auth-error", "Je gegevens konden niet geladen worden. Ververs de pagina.");
    show("auth");
    return;
  }

  $("nav").hidden = false;

  if (!state.profile) {
    show("onboarding");
  } else {
    renderToday();
    show("today");
  }
}

db.auth.getSession().then(({ data }) => {
  if (!data.session) {
    $("boot").hidden = true;
    show("auth");
  }
});

/* ======================= PWA ======================= */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");

      // Stilletjes bijwerken is verwarrend als iemand middenin het loggen zit,
      // dus we melden het en laten de gebruiker kiezen wanneer.
      reg.addEventListener("updatefound", () => {
        const nieuwe = reg.installing;
        nieuwe?.addEventListener("statechange", () => {
          if (nieuwe.state === "installed" && navigator.serviceWorker.controller) {
            toast("Nieuwe versie klaar. Sluit de app en open hem opnieuw.");
          }
        });
      });
    } catch {
      // Zonder servicewerker werkt alles nog, alleen niet offline.
    }
  });
}

// Snelkoppeling vanaf het beginscherm: /?scherm=add opent meteen de camera.
const gevraagdScherm = new URLSearchParams(location.search).get("scherm");
if (gevraagdScherm) {
  const opStart = setInterval(() => {
    if (state.user && state.profile) {
      clearInterval(opStart);
      show(gevraagdScherm);
      history.replaceState(null, "", "/");
    }
  }, 200);
  setTimeout(() => clearInterval(opStart), 8000);
}
