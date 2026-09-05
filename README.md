# Dagbudget

Macrotracker met foto-analyse. Statische front-end, één serverless functie, Supabase als database. Installeerbaar op je beginscherm.

## Op je telefoon zetten

Deploy eerst (zie hieronder), open het adres in **Safari** op je iPhone en tik op Deel → **Zet op beginscherm**. Je krijgt een icoon en een volledig scherm zonder browserbalk.

Op Android verschijnt in Chrome vanzelf een installatiebalk, of via het menu → App installeren.

Twee dingen om te weten op iOS:

- Het moet Safari zijn. Chrome op iOS kan geen apps op het beginscherm zetten.
- Elke geïnstalleerde app heeft zijn eigen opslag. Je blijft ingelogd in de app ook als je in Safari uitlogt, en andersom.

Offline werkt de app-schil, maar je maaltijden komen uit Supabase en die heeft verbinding nodig. Dat is met opzet: een gecachet dagoverzicht laat je naar de cijfers van gisteren kijken zonder dat je het doorhebt.

## Bestanden

```
index.html              alle schermen
styles.css
app.js                  auth, berekening, opslag, tekenen
sw.js                   servicewerker, cachet alleen de schil
manifest.webmanifest
icons/                  gegenereerd, niet met de hand bewerken
tools/make-icons.py     draai dit na een kleurwijziging
api/analyze-meal.js     serverless functie richting Claude
```

## Wat je nog moet doen voordat het werkt

### 1. Auth aanzetten in Supabase

Dashboard → Authentication → Providers → **Email** inschakelen.

Zet onder Authentication → URL Configuration je site-URL op het adres waar de app komt te draaien, anders kloppen de bevestigingslinks in de mail niet.

Wil je zonder mailbevestiging kunnen testen: Authentication → Providers → Email → **Confirm email** uitzetten. Zet dat weer aan voordat anderen de app gebruiken.

### 2. Anthropic-sleutel als omgevingsvariabele

De foto-analyse draait via `/api/analyze-meal`. Die functie heeft nodig:

| Variabele | Waarde |
|---|---|
| `ANTHROPIC_API_KEY` | Je sleutel uit console.anthropic.com |
| `SUPABASE_URL` | `https://gcnrgrmmsajatoblhvfb.supabase.co` (optioneel, staat al als fallback in de code) |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (optioneel, idem) |

Zet die op Vercel onder Settings → Environment Variables. **Nooit** in `app.js` — dat bestand staat open en bloot in de browser.

### 3. Deployen

```bash
npm i -g vercel
vercel
```

Of push de map naar GitHub en koppel de repo aan Vercel. Er is geen build-stap; Vercel serveert `index.html` en pakt `api/analyze-meal.js` automatisch op als functie.

Lokaal testen met de API-functie erbij:

```bash
vercel dev
```

Alleen `index.html` openen in je browser werkt niet — dan is er geen `/api` en gaat de analyse stuk (invullen met de hand werkt wel).

## Hoe de berekening werkt

**Ruststofwisseling** volgens Mifflin-St Jeor.

**Onderhoudsniveau** is niet de gebruikelijke grove tabel. Dagelijkse activiteit en trainingen worden apart opgeteld:

```
multiplier = dagelijkse basis + aantal trainingen × kosten per training
```

Dagelijkse basis loopt van 1,20 (zittend) tot 1,58 (zwaar fysiek werk). Kosten per training: 0,022 rustig, 0,038 stevig, 0,055 zwaar. Gemaximeerd op 1,95.

Reden: de standaardtabel zet "3–5× sporten" op 1,55, wat voor iemand met een kantoorbaan te hoog is. Het tekort klopt dan op papier maar niet op de weegschaal.

**Dagbudget** = onderhoud − (tempo in kg/week × 7700 ÷ 7). Met een ondergrens op de ruststofwisseling zelf, en absoluut niet onder 1500 kcal (man) of 1200 kcal (vrouw). Kiest iemand een tempo dat daaronder duikt, dan wordt het budget opgetrokken en zegt de app dat erbij.

Een eerdere versie legde die grens op 110% van de ruststofwisseling. Dat bleek te streng: iemand met zittend werk heeft een onderhoudsniveau van maar ~1,2× BMR, dus een normaal tekort van 550 kcal landt daar per definitie onder en werd onterecht afgetopt.

**Eiwit** hangt aan trainingsfrequentie en intensiteit:

| Trainingen/week | Basis |
|---|---|
| 0–1 | 1,4 g/kg |
| 2–3 | 1,6 g/kg |
| 4–5 | 1,8 g/kg |
| 6–7 | 2,0 g/kg |

Daarbovenop: rustig −0,15, zwaar +0,20. Krachttraining +0,10, cardio −0,05. Geknepen tussen 1,4 en 2,4 g/kg.

Bij 0 trainingen per week vervallen die toeslagen — je kunt niet "rustig" trainen als je niet traint. Dan blijft 1,4 g/kg staan.

Gerekend over **streefgewicht** als dat lager ligt dan het huidige gewicht. Anders krijgt iemand van 110 kg een doel van 220 g eiwit, en dat eet niemand vol.

**Vet** minimaal 0,8 g/kg (onder ongeveer 0,5 g/kg komt de hormoonhuishouding in de knel). **Koolhydraten** vullen de rest op.

De doelen worden opnieuw berekend bij elke weging, zodat het budget meezakt als je afvalt. Oude doelen blijven staan met hun eigen `effective_from`, dus een dag van vorige maand wordt nog steeds tegen het budget van toen afgezet.

## Een waarschuwing over de foto-analyse

Portiegrootte is op een foto slecht te zien. Twee borden pasta die er identiek uitzien kunnen 400 kcal schelen. De app toont daarom altijd bewerkbare velden en een regel over de betrouwbaarheid, en bewaart de oorspronkelijke schatting in `analysis_raw` naast wat jij ervan maakte. Behandel de getallen als een startpunt, niet als een meting.

Deze app is geen medisch hulpmiddel. Bij een eetstoornis in je verleden, zwangerschap, diabetes of medicijngebruik: overleg met een arts of diëtist voordat je een calorietekort aanhoudt.
