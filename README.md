# ArgusSpace Research

Scansione storica (5 anni) su GEO belt + LEO alto valore per trovare
candidati di prossimità/manovra **non ancora segnalati pubblicamente**.
Repo separato e pubblico apposta — gira su GitHub Actions per ore senza
consumare i minuti gratuiti (limitati) di un repo privato, e senza bisogno
di eseguire nulla in locale.

Nessun segreto o codice proprietario qui dentro: solo tooling di analisi
orbitale su fonti dati pubbliche (CelesTrak, Space-Track, UCS Satellite
Database). Le credenziali vivono nei GitHub Secrets, mai nel codice.

## Setup (una tantum)

1. **Account Space-Track.org** (gratuito, verifica manuale) — poi in
   Settings → Secrets and variables → Actions di questo repo, aggiungi:
   - `SPACETRACK_IDENTITY`
   - `SPACETRACK_PASSWORD`
   - `SUPABASE_URL` (`https://fbctpzsoazkphqsigjkl.supabase.co`)
   - `SUPABASE_SERVICE_ROLE_KEY` (da Project Settings → API sulla dashboard Supabase)

2. **UCS Satellite Database** — già incluso in `data/ucs-satellite-database.csv`
   (snapshot 1 maggio 2023, 890 oggetti LEO alto valore già validati contro
   il parser). Consigliato riscaricare una versione più recente da
   https://www.ucsusa.org/resources/satellite-database prima di un run
   definitivo — vedi `data/README.md`.

## Esecuzione

Vai su **Actions → Historical Backfill → Run workflow** su GitHub. Manuale,
nessuno scheduling — è un'analisi occasionale, non un job ricorrente.

Il workflow fa, in ordine:
1. Costruisce la popolazione (GEO da CelesTrak + LEO alto valore dal CSV)
2. Scarica lo storico da Space-Track, rileva manovre e candidati di
   prossimità (screening a due fasi, vedi sotto)
3. Carica i candidati su Supabase (`research_candidates`, `reviewed = false`)
4. Salva anche l'output completo come artifact scaricabile (30 giorni)

## Perché non tutti-contro-tutti

Popolazione GEO + LEO alto valore ≈ 1.500-2.000 oggetti. Confronto a coppie
ingenuo su 5 anni di dati giornalieri sarebbe O(n² × giorni) — miliardi di
confronti, intrattabile. Due scorciatoie specifiche per dominio in
`src/screening.ts`:

- **GEO**: oggetti a longitudine ~fissa → si ordina per longitudine ogni
  giorno, si confronta ogni oggetto solo con i k=5 vicini più prossimi.
  Cattura la stessa classe di eventi documentati (Luch/Olymp, Shijian-21
  erano avvicinamenti tra vicini in longitudine).
- **LEO alto valore**: insieme piccolo ma piani orbitali variabili → si
  pre-filtra alle coppie con fascia di altitudine simile (perigeo/apogeo
  entro 200km) prima del controllo giorno per giorno.
- **GEO×LEO non confrontato**: regime fisico diverso, fuori scope —
  limitazione dichiarata, non un bug.

## Pipeline a due fasi

1. **Grossolana**: una posizione al giorno per oggetto (non ogni TLE) —
   indice compatto, ~100MB per l'intera popolazione × 5 anni invece di GB
   di TLE grezzi.
2. **Raffinamento** (manuale, sui candidati emersi): tornare ai TLE reali di
   quella finestra specifica e ricalcolare la distanza minima precisa —
   stessa logica di `detect-proximity.ts` nel repo principale
   (`arguspace-sda-scaffold`). Non automatizzato qui: il numero di
   candidati dalla fase grossolana dovrebbe essere gestibile per revisione
   mirata.

I TLE storici grezzi non vengono salvati da nessuna parte in modo
permanente — solo gli eventi (poche centinaia di righe) finiscono su
Supabase.

## Limite epistemico

**L'assenza di copertura stampa su un evento non prova che sia anomalo.**
Ogni candidato va trattato come "da verificare", non come scoperta
confermata:

- Potrebbe essere noto ma poco coperto dalla stampa generalista —
  controllare report specialistici (CSIS Aerospace Security Project, Secure
  World Foundation, COMSPOC, ExoAnalytic Solutions) prima di dichiarare
  "non documentato"
- La fase grossolana campiona un giorno alla volta — eventi molto brevi
  (ore, non giorni) possono sfuggire
- Il proxy lat/lng nello screening ignora la rotazione terrestre (GMST) —
  valido per confronti relativi tra oggetti allo stesso istante (per questo
  funziona per lo screening), non va riusato come posizione geografica reale

## File

```
src/
  lib/tle-fetch.ts        parsing/fetch TLE (CelesTrak)
  lib/propagate.ts        propagazione SGP4, calcolo distanze
  lib/supabase-client.ts  client per push-candidates.ts
  spacetrack-client.ts    auth + query batched con rate limiting (30/min, 300/ora)
  screening.ts            algoritmi di screening scalabili (testati)
  build-population.ts     GEO (CelesTrak) + LEO alto valore (UCS DB)
  backfill.ts             orchestratore principale, con checkpoint
  push-candidates.ts      carica i risultati su Supabase
```
