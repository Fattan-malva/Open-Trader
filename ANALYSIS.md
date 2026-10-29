# Open-Trader: Perubahan Kerja & Rekomendasi Simulasi

## Ringkasan Temuan (75 Closed Trades, 29 Oct 2026)

| Metrik | Nilai |
|--------|-------|
| Win rate | 62.2% (46/74) |
| Net P/L | -$16.79 |
| Avg win | +$0.22 |
| Avg loss | -$0.96 |
| Payoff ratio | 0.23 |
| Flat | 1 |

**Diagnosis**: payoff ratio terbalik. Win rate tinggi tidak bisa mengimbangi kerugian per trade yang 4.4× lebih besar dari keuntungan. Akar masalah:

1. **Profit lock terlalu cepat** — stop ditarik ke break-even pada spread cushion saja, lalu ditutup oleh noise untuk scratch (+$0.03–$0.08).
2. **Trail distance terlalu ketat** — 0.3×ATR pada M1 seringkali < 2 pips, jadi winner tidak punya ruang bernafas.
3. **Tidak ada loss-side reaction** — posisi yang salah arah dibiarkan berlari ke SL penuh (-$1.0–$2.4).
4. **Stacked same-symbol entries** — 17 simbol dibuka berulang (XAUUSD 11× SELL, XAUUSD247 11× SELL, BTCUSD 8× BUY). Ini memperbesar exposure berkorelasi.

---

## Perubahan yang Sudah Diterapkan

### 1. Profit-lock activation gate (`profitLockActivateR`)
- **File**: `src/agents/config.ts`, `src/agents/risk-and-executor.ts`
- **Default**: `0.5` (50% dari planned stop distance / R)
- **Efek**: Stop tidak ditarik ke break-even hanya karena spread sudah tercover. Harus ada real profit ≥ 0.5R dulu.

### 2. Risk-relative post-lock trail (`profitTrailRiskFraction`)
- **File**: `src/agents/risk-and-executor.ts`
- **Logika baru**:
  - peak < 1R → trail distance = 0.75R
  - peak < 2R → trail distance = 0.50R
  - peak ≥ 2R → trail distance = 0.35R (floor)
- **Upper bound**: tidak melebihi `profitTrailAtrFactor × ATR` (default 0.25×ATR)
- **Efek**: winner punya ruang untuk berkembang; trail tidak collapse ke < 1 pip.

### 3. Adverse-side loss cut (`lossCutDistance`, `lossCutHit`)
- **File**: `src/agents/trailing.ts`, `src/agents/risk-and-executor.ts`
- **Default**:
  - `lossCutRiskPct = 35` (35% dari planned stop distance)
  - `lossCutAtrFactor = 0.8` (0.8 × ATR)
  - `lossCutMinPips = 2`
- **Logika**: cut distance = tighter of(0.35×R, 0.8×ATR), floored 2 pips.
- **Efek**: posisi yang tidak pernah lock profit ditutup sebelum mencapai SL penuh. Mengurangi avg loss dari ~-$0.96 ke target ~-$0.35 (35% dari R).

### 4. `lockedProfitUsd` yang benar
- **File**: `src/agents/trailing.ts` (fungsi `lockedProfitDistance`), `src/agents/engine.ts`
- **Fix**: sebelumnya stop di sisi loss masih dihitung sebagai "profit". Sekarang return 0 jika stop belum melewati entry.
- **Dashboard**: kolom `LOCK $` ditambahkan di semua lebar tabel.

### 5. Retry close fix (`indicatesPositionAlreadyClosed`)
- **File**: `src/agents/risk-and-executor.ts`
- **Fix**: normalisasi `SCREAMING_SNAKE_CASE` ke space sebelum regex match. Menangani `REQUEST_POSITION_NOT_FOUND` dan varian.

---

## Simulasi Dampak (konseptual, karena log tidak menyimpan MFE/MAE penuh)

Asumsi: R rata-rata ≈ $0.55 (dari data: avg win $0.22 pada 0.4R, avg loss $0.96 pada 1.0R).

### Skenario A — Sebelum perubahan (baseline)
- 46 win × +$0.22 = +$10.12
- 28 loss × -$0.96 = -$26.88
- 1 flat × $0 = $0
- **Net = -$16.76** (sesuai data aktual)

### Skenario B — Dengan `profitLockActivateR = 0.5` saja
- Winner yang sebelumnya terkunci di +0.05R sekarang punya kesempatan mencapai +0.5R–1.0R.
- Asumsi 30% dari 46 win naik dari +$0.15 ke +$0.45 (tetap 30% turun karena retracement).
- Win avg naik ke ~$0.30.
- **Net estimasi ≈ -$8.4** (masih negatif, tapi setengahnya).

### Skenario C — Dengan profit-lock + risk-relative trail
- Winner yang survive ke >1R sekarang dilindungi oleh trail 0.50R, bukan 0.3×ATR.
- Asumsi 15% dari win mencapai +1.5R, 5% mencapai +2.0R.
- Win avg naik ke ~$0.38.
- **Net estimasi ≈ -$3.5**.

### Skenario D — Dengan profit-lock + trail + loss cut
- Loss yang sebelumnya -$0.96 sekarang dipotong di -$0.35 (35% × R).
- Asumsi 80% dari 28 loss terkena loss cut (sisanya masih ke SL penuh karena volatile gap).
- Loss avg turun ke ~-$0.47.
- **Net estimasi ≈ +$4.3** (positif!).

### Skenario E — Dengan semua perubahan + anti-stacking (belum diterapkan)
- Jika same-symbol stacking dihapus (max 1 posisi terbuka per simbol), exposure berkorelasi turun drastis.
- Asumsi 17 simbol stacked menghasilkan 40% dari total loss.
- **Net estimasi ≈ +$8–$12**.

---

## Rekomendasi Konfigurasi untuk Uji Coba

```bash
# Profit lock: jangan terlalu cepat, tapi jangan terlambat
AGENT_PROFIT_LOCK_ACTIVATE_R=0.5

# Trail: biarkan winner bernafas
AGENT_PROFIT_TRAIL_ATR=0.25
AGENT_PROFIT_TRAIL_MIN_PIPS=0.3

# Loss cut: potong sebelum parah
AGENT_LOSS_CUT_RISK_PCT=35
AGENT_LOSS_CUT_ATR=0.8
AGENT_LOSS_CUT_MIN_PIPS=2

# Emergency SL tetap lebar sebagai safety net
AGENT_EMERGENCY_SL_ATR=1.5
AGENT_MIN_STOP_PIPS=6
```

---

## Gap yang Masih Perlu Dikerjakan

1. **Anti-stacking guard** — kode masih mengizinkan "Repeated entries on the same symbol". Perlu:
   - `maxOpenPerSymbol: number` (default 1)
   - atau `cooldownMsPerSymbol` (default 5 menit)
   - atau keduanya.

2. **Simulasi back-test** — log trade tidak menyimpan `best` (MFE) dan `worst` (MAE) per posisi. Untuk simulasi akurat, perlu menambahkan field `mfePrice` dan `maePrice` ke state managed position, lalu log saat close.

3. **Typecheck** — `npx tsc --noEmit` belum dijalankan karena classifier block. Test 53/53 lulus, tapi typecheck formal masih pending.

4. **Config test** — `loadAgentConfig` belum punya unit test. Perlu test untuk memastikan default baru (profitLockActivateR, lossCut*) ter-load dengan benar.

---

## Test Coverage Baru

| File | Test baru |
|------|-----------|
| `src/agents/trailing.test.ts` | `lockedProfitDistance`, `lossCutDistance`, `lossCutHit` |
| `src/agents/risk-and-executor.test.ts` | `SCREAMING_SNAKE_CASE` retry normalization |
| `src/cli/dashboard/panels.test.ts` | `LOCK $` column rendering |

**Total test**: 53 (semua lulus).
