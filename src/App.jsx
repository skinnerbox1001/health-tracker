import { useState, useEffect, useRef } from "react";

const ENTRY_KEY = "health-tracker-entries";
const MED_KEY   = "health-tracker-meds";
const APT_KEY   = "health-tracker-appointments"; // {lastVisit, nextVisit}
const NOTE_KEY  = "health-tracker-notes"; // [{id, date, text}]

const moodLabels = ["","最悪","かなり辛い","辛い","しんどい","普通以下","まあまあ","普通","良い","かなり良い","最高"];
const moodColors = ["","#ef4444","#f97316","#fb923c","#fbbf24","#a3e635","#34d399","#22d3ee","#60a5fa","#818cf8","#c084fc"];

function getTodayKey() { return new Date().toISOString().split("T")[0]; }
function formatDate(d) {
  if (!d) return "未設定";
  const dt = new Date(d);
  return `${dt.getMonth()+1}/${dt.getDate()}(${["日","月","火","水","木","金","土"][dt.getDay()]})`;
}
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export default function HealthTracker() {
  const [entries, setEntries]         = useState({});
  const [meds, setMeds]               = useState([]);
  const [apt, setApt]                 = useState({ lastVisit: "", nextVisit: "" });
  const [view, setView]               = useState("log");
  const [today, setToday]             = useState(() => ({
    date: getTodayKey(), mood: 5, sleep: 7,
    food: 2, exercise: 0, exerciseNote: "",
    bad: "", good: "", memo: "", medsTaken: {}
  }));
  const [aiSummary, setAiSummary]     = useState("");
  const [loading, setLoading]         = useState(false);
  const [saved, setSaved]             = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedMeds, setScannedMeds] = useState(null);
  const [scanError, setScanError]     = useState("");
  const [calStatus, setCalStatus]     = useState(""); // "", "loading", "done", "error"
  const [notes, setNotes]               = useState([]); // [{id, date, text}]
  const fileRef = useRef();

  useEffect(() => {
    try { const e = localStorage.getItem(ENTRY_KEY); if (e) { const p=JSON.parse(e); setEntries(p); const k=getTodayKey(); if(p[k]) setToday(p[k]); } } catch {}
    try { const m = localStorage.getItem(MED_KEY);   if (m) setMeds(JSON.parse(m)); } catch {}
    try { const a = localStorage.getItem(APT_KEY);   if (a) setApt(JSON.parse(a)); } catch {}
    try { const n = localStorage.getItem(NOTE_KEY);  if (n) setNotes(JSON.parse(n)); } catch {}
  }, []);

  useEffect(() => {
    if (meds.length === 0) return;
    setToday(prev => {
      const mt = { ...prev.medsTaken };
      meds.forEach(m => { if (mt[m.id] === undefined) mt[m.id] = true; });
      return { ...prev, medsTaken: mt };
    });
  }, [meds]);

  function saveEntry() {
    const key = getTodayKey();
    const updated = { ...entries, [key]: { ...today, date: key } };
    setEntries(updated);
    try { localStorage.setItem(ENTRY_KEY, JSON.stringify(updated)); } catch {}
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  function saveMeds(newMeds) {
    setMeds(newMeds);
    try { localStorage.setItem(MED_KEY, JSON.stringify(newMeds)); } catch {}
  }

  function saveApt(newApt) {
    setApt(newApt);
    try { localStorage.setItem(APT_KEY, JSON.stringify(newApt)); } catch {}
  }

  function saveNotes(newNotes) {
    setNotes(newNotes);
    try { localStorage.setItem(NOTE_KEY, JSON.stringify(newNotes)); } catch {}
  }

  function takeAll() {
    const mt = {};
    meds.forEach(m => { mt[m.id] = true; });
    setToday(prev => ({ ...prev, medsTaken: mt }));
  }

  async function handleScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanLoading(true); setScanError(""); setScannedMeds(null);
    try {
      const b64 = await fileToBase64(file);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
            { type: "text", text: `この処方箋から薬の情報を読み取り、必ずJSON配列のみを返してください。
形式: [{"name":"薬品名","dose":"用量","timing":"用法（朝食後など）","note":"備考"}]
薬が複数あれば全て含めてください。読み取れない場合は空配列[]を返してください。` }
          ]}]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text||"").join("") || "[]";
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      setScannedMeds(parsed.map((m,i) => ({ ...m, id:`med_${Date.now()}_${i}` })));
    } catch { setScanError("読み取りに失敗しました。"); }
    setScanLoading(false); e.target.value="";
  }

  function confirmScan() {
    if (!scannedMeds) return;
    saveMeds([...meds, ...scannedMeds]); setScannedMeds(null);
  }

  // ── Google Calendar 同期 ──
  function syncToCalendar() {
    if (!apt.nextVisit) return;
    const d = apt.nextVisit.replace(/-/g, "");
    let startStr, endStr;
    if (apt.nextVisitTime) {
      const [h, m] = apt.nextVisitTime.split(":").map(Number);
      const endH = h + (m + 60 >= 60 ? 1 : 0);
      const endM = (m + 60) % 60;
      startStr = `${d}T${String(h).padStart(2,"0")}${String(m).padStart(2,"0")}00`;
      endStr   = `${d}T${String(endH % 24).padStart(2,"0")}${String(endM).padStart(2,"0")}00`;
    } else {
      startStr = d; endStr = d;
    }
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE`
      + `&text=${encodeURIComponent("精神科受診")}`
      + `&dates=${startStr}/${endStr}`
      + `&details=${encodeURIComponent("高須メンタルクリニック")}`
      + `&location=${encodeURIComponent("高須メンタルクリニック")}`;
    window.open(url, "_blank");
  }

  // ── 診察サマリー生成 ──
  async function generateSummary() {
    setLoading(true); setAiSummary(""); setView("summary");

    // 期間を決める：前回受診日〜次回受診日（なければ最初の記録〜今日）
    const allKeys = Object.keys(entries).sort();
    if (allKeys.length === 0) {
      setAiSummary("記録がまだありません。まず数日間記録してから生成してください。");
      setLoading(false); return;
    }
    const startDate = apt.lastVisit || allKeys[0];
    const endDate   = apt.nextVisit || getTodayKey();
    const rangeKeys = allKeys.filter(k => k >= startDate && k <= endDate);
    const targetKeys = rangeKeys.length > 0 ? rangeKeys : allKeys.slice(-14);

    // 要注目日（スコア4以下）を自動抽出
    const flaggedDays = targetKeys.filter(k => entries[k]?.mood <= 4);

    // 経過ノートを期間内のものに絞る
    const relevantNotes = notes.filter(n => n.date >= startDate && n.date <= endDate);

    const medNames = meds.map(m=>m.name).join("、") || "なし";
    const entryText = targetKeys.map(k => {
      const e = entries[k];
      const takenList = meds.map(m=>`${m.name}:${e.medsTaken?.[m.id]!==false?"服薬":"スキップ"}`).join(" ");
      return `【${formatDate(k)}】気分:${e.mood}/10 睡眠:${e.sleep}h 食事:${["ほぼ食べられなかった","少ししか","普通","よく食べた"][e.food??2]} 運動:${["なし","少し","しっかり"][e.exercise??0]}${e.exerciseNote?`(${e.exerciseNote})`:""} 服薬:[${takenList||"記録なし"}] 辛かった:${e.bad||"なし"} 良かった:${e.good||"なし"} メモ:${e.memo||"なし"}`;
    }).join("\n");

    const periodText = apt.lastVisit
      ? `前回受診日(${formatDate(apt.lastVisit)})〜次回受診日(${formatDate(apt.nextVisit)||"未設定"})`
      : `記録開始(${formatDate(allKeys[0])})〜現在`;

    const notesText = relevantNotes.length > 0
      ? relevantNotes.map(n => `【${formatDate(n.date)}】${n.text}`).join("\n")
      : "なし";
    const flaggedText = flaggedDays.length > 0
      ? flaggedDays.map(k => `${formatDate(k)}（スコア${entries[k].mood}）`).join("、")
      : "なし";

    const prompt = `患者の体調記録です。うつ病療養中。処方薬：${medNames}。
対象期間：${periodText}（${targetKeys.length}日分）

精神科・心療内科の診察（10〜15分）向けに整理してください。

【経過ノート（重要イベント・節目）】
${notesText}

【要注目日（気分スコア4以下）】
${flaggedText}

【日別記録】
${entryText}

以下の形式で出力してください：

## 📊 ${periodText}のまとめ
（気分・睡眠・食事・運動・服薬の全体傾向を簡潔に）

## ⚠️ 先生に必ず伝えること
（特に辛かった日・服薬スキップのパターンを3点以内で箇条書き）

## 💬 診察で使える一言
（最初に先生に言う短いセリフ例を1〜2文）

## ❓ 先生への質問候補
（今の状態を踏まえた質問3つ）

## 📈 気になるパターン
（睡眠・気分・食事・服薬の相関など）`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, messages:[{role:"user",content:prompt}] })
      });
      const data = await res.json();
      setAiSummary(data.content?.map(b=>b.text||"").join("")||"生成に失敗しました");
    } catch { setAiSummary("エラーが発生しました。"); }
    setLoading(false);
  }

  const recentDays = Object.keys(entries).sort().slice(-7).reverse();

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0f1117 0%,#1a1f2e 50%,#161b27 100%)", fontFamily:"'Georgia','Noto Serif JP',serif", color:"#e8e0d0", paddingBottom:"80px" }}>

      <div style={{ background:"rgba(255,255,255,0.03)", borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"20px 20px 16px", position:"sticky", top:0, zIndex:10, backdropFilter:"blur(12px)" }}>
        <div style={{ fontSize:"11px", letterSpacing:"3px", color:"#7c8a9e", textTransform:"uppercase", marginBottom:"4px" }}>Daily Wellness Log</div>
        <div style={{ fontSize:"22px", fontWeight:"bold", color:"#e8e0d0" }}>体調記録帳</div>
      </div>

      <div style={{ display:"flex", padding:"12px 16px", gap:"6px" }}>
        {[["log","今日"],["history","履歴"],["notes","経過"],["meds","お薬"],["summary","診察"]].map(([v,label]) => (
          <button key={v} onClick={() => setView(v)} style={{ flex:1, padding:"10px 4px", borderRadius:"10px", border:"none", background:view===v?"rgba(99,179,237,0.2)":"rgba(255,255,255,0.04)", color:view===v?"#63b3ed":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", borderBottom:view===v?"2px solid #63b3ed":"2px solid transparent", transition:"all 0.2s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding:"8px 16px" }}>

        {/* ═══ 今日 ═══ */}
        {view === "log" && (
          <div>
            <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"20px", textAlign:"center" }}>{formatDate(getTodayKey())} の記録</div>

            <div style={C}>
              <div style={L}>今日の気分</div>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"12px" }}>
                <div style={{ fontSize:"48px", fontWeight:"bold", color:moodColors[today.mood], lineHeight:1 }}>{today.mood}</div>
                <div><div style={{ fontSize:"16px", color:moodColors[today.mood] }}>{moodLabels[today.mood]}</div><div style={{ fontSize:"11px", color:"#7c8a9e" }}>10段階</div></div>
              </div>
              <input type="range" min="1" max="10" value={today.mood} onChange={e=>setToday({...today,mood:+e.target.value})} style={{ width:"100%", accentColor:moodColors[today.mood] }} />
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:"10px", color:"#4a5568", marginTop:"4px" }}><span>最悪 1</span><span>10 最高</span></div>
            </div>

            <div style={C}>
              <div style={L}>睡眠時間</div>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"12px" }}>
                <div style={{ fontSize:"48px", fontWeight:"bold", color:"#63b3ed", lineHeight:1 }}>{today.sleep}</div>
                <div style={{ fontSize:"16px", color:"#63b3ed" }}>時間</div>
              </div>
              <input type="range" min="1" max="12" step="0.5" value={today.sleep} onChange={e=>setToday({...today,sleep:+e.target.value})} style={{ width:"100%", accentColor:"#63b3ed" }} />
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:"10px", color:"#4a5568", marginTop:"4px" }}><span>1h</span><span>12h</span></div>
            </div>

            {meds.length > 0 ? (
              <div style={C}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"12px" }}>
                  <div style={L}>💊 今日の服薬</div>
                  <button onClick={takeAll} style={{ padding:"6px 12px", borderRadius:"8px", border:"1px solid rgba(52,211,153,0.4)", background:"rgba(52,211,153,0.15)", color:"#34d399", fontSize:"12px", fontFamily:"inherit", cursor:"pointer" }}>全部飲んだ ✓</button>
                </div>
                {meds.map(m => {
                  const taken = today.medsTaken?.[m.id] !== false;
                  return (
                    <div key={m.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                      <div>
                        <div style={{ fontSize:"14px", color:taken?"#e8e0d0":"#4a5568", textDecoration:taken?"none":"line-through" }}>{m.name}</div>
                        <div style={{ fontSize:"11px", color:"#7c8a9e" }}>{m.dose} / {m.timing}</div>
                      </div>
                      <button onClick={() => setToday(prev=>({...prev,medsTaken:{...prev.medsTaken,[m.id]:!taken}}))} style={{ padding:"8px 14px", borderRadius:"8px", border:`1px solid ${taken?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.1)"}`, background:taken?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.06)", color:taken?"#34d399":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.2s" }}>{taken?"✓ 服薬":"スキップ"}</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ ...C, border:"1px dashed rgba(255,255,255,0.1)", textAlign:"center", color:"#4a5568", fontSize:"13px", lineHeight:"1.8" }}>💊 「お薬」タブで処方箋を登録すると<br/>ここに服薬チェックが表示されます</div>
            )}

            <div style={C}>
              <div style={L}>🍚 今日の食事</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                {["ほぼ食べられなかった","少ししか食べられなかった","普通に食べた","よく食べた"].map((label,i) => (
                  <button key={i} onClick={()=>setToday({...today,food:i})} style={{ padding:"12px 8px", borderRadius:"10px", border:`1px solid ${today.food===i?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.07)"}`, background:today.food===i?"rgba(251,191,36,0.25)":"rgba(255,255,255,0.04)", color:today.food===i?"#fbbf24":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", lineHeight:"1.4", transition:"all 0.2s" }}>{label}</button>
                ))}
              </div>
            </div>

            <div style={C}>
              <div style={L}>🚶 今日の運動・外出</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px", marginBottom:"10px" }}>
                {["なし","少し動いた","しっかり動いた"].map((label,i) => (
                  <button key={i} onClick={()=>setToday({...today,exercise:i})} style={{ padding:"12px 6px", borderRadius:"10px", border:`1px solid ${today.exercise===i?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.07)"}`, background:today.exercise===i?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.04)", color:today.exercise===i?"#34d399":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.2s" }}>{label}</button>
                ))}
              </div>
              {today.exercise > 0 && <input type="text" value={today.exerciseNote||""} onChange={e=>setToday({...today,exerciseNote:e.target.value})} placeholder="内容メモ（散歩20分など）" style={{...TA,padding:"8px 10px",fontSize:"13px"}} />}
            </div>

            <div style={C}><div style={L}>😔 辛かったこと・引き金になったこと</div><textarea value={today.bad} onChange={e=>setToday({...today,bad:e.target.value})} placeholder="なければ空白でOK" style={TA} rows={3} /></div>
            <div style={C}><div style={L}>😊 良かったこと・ほっとしたこと</div><textarea value={today.good} onChange={e=>setToday({...today,good:e.target.value})} placeholder="小さなことでもOK" style={TA} rows={3} /></div>
            <div style={C}><div style={L}>📝 その他メモ</div><textarea value={today.memo} onChange={e=>setToday({...today,memo:e.target.value})} placeholder="特記事項など" style={TA} rows={2} /></div>

            <button onClick={saveEntry} style={{ width:"100%", padding:"16px", borderRadius:"12px", border:`1px solid ${saved?"rgba(52,211,153,0.4)":"rgba(99,179,237,0.3)"}`, background:saved?"rgba(52,211,153,0.3)":"rgba(99,179,237,0.25)", color:saved?"#34d399":"#63b3ed", fontSize:"16px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.3s", fontWeight:"bold" }}>
              {saved ? "✓ 保存しました" : "今日の記録を保存"}
            </button>
          </div>
        )}

        {/* ═══ 履歴 ═══ */}
        {view === "history" && (
          <div>
            {recentDays.length === 0
              ? <div style={{ textAlign:"center", color:"#7c8a9e", padding:"40px 0" }}>まだ記録がありません</div>
              : recentDays.map(key => {
                const e = entries[key];
                const skipped = meds.filter(m => e.medsTaken?.[m.id] === false);
                return (
                  <div key={key} style={{...C, marginBottom:"12px"}}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}>
                      <span style={{ fontSize:"13px", color:"#7c8a9e" }}>{formatDate(key)}</span>
                      <div style={{ display:"flex", gap:"12px", alignItems:"center" }}>
                        <span style={{ fontSize:"12px", color:"#63b3ed" }}>😴 {e.sleep}h</span>
                        <span style={{ fontSize:"22px", fontWeight:"bold", color:moodColors[e.mood] }}>{e.mood}</span>
                      </div>
                    </div>
                    <div style={{ fontSize:"12px", color:"#9ca3af", marginBottom:"6px" }}>{moodLabels[e.mood]}</div>
                    <div style={{ display:"flex", gap:"10px", flexWrap:"wrap", marginBottom:"4px" }}>
                      {e.food != null && <span style={{ fontSize:"11px", color:"#fbbf24" }}>🍚 {["ほぼ×","少し食","普通","よく食"][e.food]}</span>}
                      {e.exercise != null && <span style={{ fontSize:"11px", color:"#34d399" }}>🚶 {["なし","少し","しっかり"][e.exercise]}</span>}
                      {meds.length > 0 && skipped.length === 0 && <span style={{ fontSize:"11px", color:"#34d399" }}>💊 全服薬</span>}
                      {skipped.length > 0 && <span style={{ fontSize:"11px", color:"#f87171" }}>💊 skip:{skipped.map(m=>m.name).join("・")}</span>}
                    </div>
                    {e.bad && <div style={{ fontSize:"12px", color:"#f87171", marginTop:"4px" }}>😔 {e.bad}</div>}
                    {e.good && <div style={{ fontSize:"12px", color:"#34d399", marginTop:"4px" }}>😊 {e.good}</div>}
                  </div>
                );
              })
            }
          </div>
        )}

        {/* ═══ お薬 ═══ */}
        {view === "meds" && (
          <div>
            <ManualMedForm onAdd={m => saveMeds([...meds, { ...m, id:`med_${Date.now()}` }])} />

            <div style={{ ...C, background:"rgba(99,179,237,0.06)", border:"1px solid rgba(99,179,237,0.2)", textAlign:"center" }}>
              <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"12px" }}>処方箋を撮影するとAIが薬の情報を自動読み取りします<br/><span style={{fontSize:"11px",color:"#4a5568"}}>(APIキー設定後に使用可能)</span></div>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleScan} style={{ display:"none" }} />
              <button onClick={()=>fileRef.current?.click()} disabled={scanLoading} style={{ width:"100%", padding:"14px", borderRadius:"10px", border:"1px solid rgba(99,179,237,0.4)", background:"rgba(99,179,237,0.15)", color:"#63b3ed", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold", opacity:scanLoading?0.6:1 }}>
                {scanLoading ? "📷 読み取り中..." : "📷 処方箋を撮影・読み込む"}
              </button>
              {scanError && <div style={{ marginTop:"10px", fontSize:"12px", color:"#f87171" }}>{scanError}</div>}
            </div>

            {scannedMeds && (
              <div style={{ ...C, border:"1px solid rgba(251,191,36,0.3)", background:"rgba(251,191,36,0.05)" }}>
                <div style={{ fontSize:"13px", color:"#fbbf24", marginBottom:"12px", fontWeight:"bold" }}>📋 読み取れた薬を確認してください</div>
                {scannedMeds.length === 0
                  ? <div style={{ fontSize:"13px", color:"#7c8a9e" }}>薬の情報を読み取れませんでした。</div>
                  : scannedMeds.map((m,i) => (
                    <div key={i} style={{ padding:"10px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize:"14px", color:"#e8e0d0", marginBottom:"2px" }}>{m.name}</div>
                      <div style={{ fontSize:"12px", color:"#7c8a9e" }}>{m.dose} ／ {m.timing}</div>
                    </div>
                  ))
                }
                <div style={{ display:"flex", gap:"10px", marginTop:"14px" }}>
                  {scannedMeds.length > 0 && <button onClick={confirmScan} style={{ flex:1, padding:"12px", borderRadius:"10px", border:"1px solid rgba(52,211,153,0.4)", background:"rgba(52,211,153,0.2)", color:"#34d399", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold" }}>✓ 登録する</button>}
                  <button onClick={()=>setScannedMeds(null)} style={{ flex:1, padding:"12px", borderRadius:"10px", border:"1px solid rgba(255,255,255,0.1)", background:"rgba(255,255,255,0.05)", color:"#7c8a9e", fontSize:"14px", fontFamily:"inherit", cursor:"pointer" }}>キャンセル</button>
                </div>
              </div>
            )}

            <div style={{ fontSize:"12px", color:"#7c8a9e", margin:"16px 0 8px", letterSpacing:"1px", textTransform:"uppercase" }}>登録済みの処方薬</div>
            {meds.length === 0
              ? <div style={{ ...C, textAlign:"center", color:"#4a5568", fontSize:"13px" }}>まだ薬が登録されていません</div>
              : meds.map(m => (
                <div key={m.id} style={{...C, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  <div>
                    <div style={{ fontSize:"15px", color:"#e8e0d0", marginBottom:"3px" }}>{m.name}</div>
                    <div style={{ fontSize:"12px", color:"#7c8a9e" }}>{m.dose} ／ {m.timing}</div>
                  </div>
                  <button onClick={()=>saveMeds(meds.filter(x=>x.id!==m.id))} style={{ padding:"6px 10px", borderRadius:"8px", border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.1)", color:"#f87171", fontSize:"12px", fontFamily:"inherit", cursor:"pointer" }}>削除</button>
                </div>
              ))
            }
          </div>
        )}

        {/* ═══ 経過ノート ═══ */}
        {view === "notes" && (
          <div>
            <NotesForm
              notes={notes}
              entries={entries}
              onSave={saveNotes}
              formatDate={formatDate}
            />
          </div>
        )}

        {/* ═══ 診察 ═══ */}
        {view === "summary" && (
          <div>
            {/* 受診日設定 */}
            <div style={{ ...C, border:"1px solid rgba(192,132,252,0.25)", background:"rgba(192,132,252,0.05)" }}>
              <div style={L}>🏥 受診日の設定</div>

              <div style={{ marginBottom:"14px" }}>
                <div style={{ fontSize:"12px", color:"#7c8a9e", marginBottom:"6px" }}>前回の受診日</div>
                <input type="date" value={apt.lastVisit} onChange={e=>saveApt({...apt,lastVisit:e.target.value})}
                  style={{...TA, padding:"10px", fontSize:"14px", colorScheme:"dark"}} />
                <div style={{ fontSize:"11px", color:"#4a5568", marginTop:"4px" }}>未入力の場合は記録開始日からサマリーを作成します</div>
              </div>

              <div style={{ marginBottom:"14px" }}>
                <div style={{ fontSize:"12px", color:"#7c8a9e", marginBottom:"6px" }}>次回の受診日</div>
                <div style={{ display:"flex", gap:"8px" }}>
                  <input type="date" value={apt.nextVisit} onChange={e=>saveApt({...apt,nextVisit:e.target.value})}
                    style={{...TA, padding:"10px", fontSize:"14px", colorScheme:"dark", flex:2}} />
                  <input type="time" value={apt.nextVisitTime||""} onChange={e=>saveApt({...apt,nextVisitTime:e.target.value})}
                    placeholder="時刻" style={{...TA, padding:"10px", fontSize:"14px", colorScheme:"dark", flex:1}} />
                </div>
                {apt.nextVisitTime && <div style={{ fontSize:"11px", color:"#c084fc", marginTop:"4px" }}>📅 {formatDate(apt.nextVisit)} {apt.nextVisitTime}〜</div>}
              </div>

              {apt.nextVisit && (
                <button onClick={syncToCalendar} style={{ width:"100%", padding:"12px", borderRadius:"10px", border:"1px solid rgba(192,132,252,0.4)", background:"rgba(192,132,252,0.15)", color:"#c084fc", fontSize:"13px", fontFamily:"inherit", cursor:"pointer" }}>
                  📅 Googleカレンダーに受診日を追加
                </button>
              )}

              {apt.lastVisit && apt.nextVisit && (
                <div style={{ marginTop:"12px", padding:"10px", borderRadius:"8px", background:"rgba(255,255,255,0.04)", fontSize:"12px", color:"#7c8a9e", textAlign:"center" }}>
                  サマリー期間：{formatDate(apt.lastVisit)} 〜 {formatDate(apt.nextVisit)}
                </div>
              )}
            </div>

            <div style={{ ...C, background:"rgba(99,179,237,0.06)", border:"1px solid rgba(99,179,237,0.2)", marginBottom:"16px" }}>
              <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"8px" }}>受診日間の記録をAIが分析して、診察に使えるサマリーを作ります</div>
              <div style={{ fontSize:"12px", color:"#4a5568" }}>記録: {Object.keys(entries).length}日分 ／ 処方薬: {meds.length}種</div>
            </div>

            <button onClick={generateSummary} disabled={loading} style={{ width:"100%", padding:"16px", borderRadius:"12px", border:"1px solid rgba(99,179,237,0.4)", background:"rgba(99,179,237,0.15)", color:"#63b3ed", fontSize:"15px", fontFamily:"inherit", cursor:loading?"not-allowed":"pointer", fontWeight:"bold", marginBottom:"20px", opacity:loading?0.6:1 }}>
              {loading ? "生成中..." : "📋 診察サマリーを生成"}
            </button>
            {loading && <div style={{ textAlign:"center", padding:"30px", color:"#7c8a9e" }}><div style={{ fontSize:"28px", marginBottom:"12px" }}>🤔</div><div>記録を分析中...</div></div>}

            {/* データ出力 */}
            <DataExport entries={entries} meds={meds} notes={notes} formatDate={formatDate} />
            {aiSummary && !loading && <div style={{ ...C, whiteSpace:"pre-wrap", fontSize:"14px", lineHeight:"1.8", color:"#d4cfc8" }}>{aiSummary}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesForm({ notes, entries, onSave, formatDate }) {
  const [text, setText] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  // 要注目日（スコア4以下）を自動取得
  const flagged = Object.entries(entries)
    .filter(([, e]) => e.mood <= 4)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 10);

  function addNote() {
    if (!text.trim()) return;
    const newNote = { id: `note_${Date.now()}`, date, text: text.trim() };
    onSave([newNote, ...notes]);
    setText(""); setDate(new Date().toISOString().split("T")[0]);
  }

  return (
    <div>
      {/* 要注目日バナー */}
      {flagged.length > 0 && (
        <div style={{ ...C, border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.05)", marginBottom:"12px" }}>
          <div style={{ fontSize:"12px", color:"#f87171", marginBottom:"10px", fontWeight:"bold" }}>🚨 要注目日（気分4以下）</div>
          {flagged.map(([key, e]) => (
            <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.04)", fontSize:"13px" }}>
              <span style={{ color:"#9ca3af" }}>{formatDate(key)}</span>
              <span style={{ color:["","#ef4444","#f97316","#fb923c","#fbbf24"][e.mood] || "#fbbf24", fontWeight:"bold" }}>
                {e.mood}/10 — {["","最悪","かなり辛い","辛い","しんどい"][e.mood] || "しんどい"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 新規ノート入力 */}
      <div style={{ ...C, border:"1px solid rgba(192,132,252,0.25)", background:"rgba(192,132,252,0.04)" }}>
        <div style={L}>📝 経過・特記事項を追加</div>
        <div style={{ marginBottom:"10px" }}>
          <div style={{ fontSize:"11px", color:"#7c8a9e", marginBottom:"5px" }}>日付</div>
          <input type="date" value={date} onChange={e=>setDate(e.target.value)}
            style={{...TA, padding:"10px", colorScheme:"dark"}} />
        </div>
        <div style={{ marginBottom:"12px" }}>
          <div style={{ fontSize:"11px", color:"#7c8a9e", marginBottom:"5px" }}>内容</div>
          <textarea value={text} onChange={e=>setText(e.target.value)}
            placeholder="例：今日から薬が変わった&#10;例：職場の件で強いストレスがあった&#10;例：受診開始時の状況メモ"
            style={TA} rows={4} />
        </div>
        <button onClick={addNote} style={{ width:"100%", padding:"12px", borderRadius:"10px", border:"1px solid rgba(192,132,252,0.4)", background:"rgba(192,132,252,0.2)", color:"#c084fc", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold" }}>
          ＋ 追加する
        </button>
      </div>

      {/* ノート一覧 */}
      <div style={{ fontSize:"12px", color:"#7c8a9e", margin:"16px 0 8px", letterSpacing:"1px", textTransform:"uppercase" }}>経過記録</div>
      {notes.length === 0
        ? <div style={{ ...C, textAlign:"center", color:"#4a5568", fontSize:"13px", lineHeight:"1.8" }}>
            まだ経過記録がありません<br/>
            <span style={{fontSize:"11px"}}>治療の経緯や節目を記録しましょう</span>
          </div>
        : [...notes].sort((a,b)=>b.date.localeCompare(a.date)).map(n => (
          <div key={n.id} style={{...C, marginBottom:"10px"}}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"8px" }}>
              <span style={{ fontSize:"12px", color:"#c084fc" }}>{formatDate(n.date)}</span>
              <button onClick={()=>onSave(notes.filter(x=>x.id!==n.id))} style={{ padding:"3px 8px", borderRadius:"6px", border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.1)", color:"#f87171", fontSize:"11px", fontFamily:"inherit", cursor:"pointer" }}>削除</button>
            </div>
            <div style={{ fontSize:"14px", color:"#d4cfc8", lineHeight:"1.7", whiteSpace:"pre-wrap" }}>{n.text}</div>
          </div>
        ))
      }
    </div>
  );
}

function DataExport({ entries, meds, notes, formatDate }) {
  const [copied, setCopied] = useState(false);

  function exportData() {
    const allKeys = Object.keys(entries).sort();
    const medNames = meds.map(m=>`${m.name}（${m.dose}・${m.timing}）`).join("、") || "なし";
    const noteText = notes.length > 0
      ? notes.sort((a,b)=>a.date.localeCompare(b.date)).map(n=>`・${formatDate(n.date)}：${n.text}`).join("\n")
      : "なし";
    const recordText = allKeys.map(k => {
      const e = entries[k];
      return `${formatDate(k)} 気分:${e.mood}/10 睡眠:${e.sleep}h 食事:${["ほぼ食べられなかった","少ししか","普通","よく食べた"][e.food??2]} 運動:${["なし","少し","しっかり"][e.exercise??0]}${e.bad?` 辛:${e.bad}`:""} ${e.good?`良:${e.good}`:""}${e.memo?` メモ:${e.memo}`:""}`;
    }).join("\n");

    const output = `【体調記録データ】
記録期間：${allKeys[0] ? formatDate(allKeys[0]) : "なし"} 〜 ${allKeys.slice(-1)[0] ? formatDate(allKeys.slice(-1)[0]) : "なし"}（${allKeys.length}日分）

【処方薬】
${medNames}

【経過・特記事項】
${noteText}

【日別記録】
${recordText}`;

    navigator.clipboard.writeText(output).then(() => {
      setCopied(true); setTimeout(()=>setCopied(false), 3000);
    }).catch(() => alert("コピーに失敗しました"));
  }

  return (
    <div style={{ ...C, border:"1px solid rgba(99,179,237,0.2)", background:"rgba(99,179,237,0.04)", marginTop:"8px" }}>
      <div style={{ fontSize:"12px", color:"#7c8a9e", marginBottom:"8px" }}>全記録データをClaudeに貼り付けて分析できます</div>
      <button onClick={exportData} style={{ width:"100%", padding:"12px", borderRadius:"10px", border:`1px solid ${copied?"rgba(52,211,153,0.4)":"rgba(99,179,237,0.3)"}`, background:copied?"rgba(52,211,153,0.2)":"rgba(99,179,237,0.1)", color:copied?"#34d399":"#63b3ed", fontSize:"13px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold", transition:"all 0.3s" }}>
        {copied ? "✓ コピーしました！Claudeに貼り付けてください" : "📋 全データをクリップボードにコピー"}
      </button>
    </div>
  );
}


function ManualMedForm({ onAdd }) {
  const [open, setOpen]     = useState(false);
  const [name, setName]     = useState("");
  const [dose, setDose]     = useState("");
  const [timing, setTiming] = useState("夕食後");

  function submit() {
    if (!name.trim()) return;
    onAdd({ name:name.trim(), dose:dose.trim()||"-", timing, note:"" });
    setName(""); setDose(""); setTiming("夕食後"); setOpen(false);
  }

  return (
    <div style={{ ...C, border:"1px solid rgba(52,211,153,0.2)", background:"rgba(52,211,153,0.03)" }}>
      <button onClick={()=>setOpen(!open)} style={{ width:"100%", padding:"12px", borderRadius:"10px", border:"1px solid rgba(52,211,153,0.35)", background:"rgba(52,211,153,0.15)", color:"#34d399", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold" }}>
        {open ? "✕ キャンセル" : "＋ 薬を手動で追加"}
      </button>
      {open && (
        <div style={{ marginTop:"14px" }}>
          <div style={{ marginBottom:"10px" }}>
            <div style={{ fontSize:"11px", color:"#7c8a9e", marginBottom:"5px" }}>薬の名前 *</div>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="例：トリンテリックス錠10mg" style={{...TA,padding:"10px"}} />
          </div>
          <div style={{ marginBottom:"10px" }}>
            <div style={{ fontSize:"11px", color:"#7c8a9e", marginBottom:"5px" }}>用量</div>
            <input value={dose} onChange={e=>setDose(e.target.value)} placeholder="例：1回2錠" style={{...TA,padding:"10px"}} />
          </div>
          <div style={{ marginBottom:"14px" }}>
            <div style={{ fontSize:"11px", color:"#7c8a9e", marginBottom:"8px" }}>飲むタイミング</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:"6px" }}>
              {["朝食後","昼食後","夕食後","就寝前","朝夕食後","毎食後"].map(t => (
                <button key={t} onClick={()=>setTiming(t)} style={{ padding:"8px 12px", borderRadius:"8px", border:`1px solid ${timing===t?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.1)"}`, background:timing===t?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.04)", color:timing===t?"#34d399":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer" }}>{t}</button>
              ))}
            </div>
          </div>
          <button onClick={submit} style={{ width:"100%", padding:"12px", borderRadius:"10px", border:"1px solid rgba(52,211,153,0.4)", background:"rgba(52,211,153,0.2)", color:"#34d399", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold" }}>✓ 追加する</button>
        </div>
      )}
    </div>
  );
}

const C  = { background:"rgba(255,255,255,0.04)", borderRadius:"14px", padding:"16px", marginBottom:"12px", border:"1px solid rgba(255,255,255,0.07)" };
const L  = { fontSize:"12px", color:"#7c8a9e", letterSpacing:"1px", textTransform:"uppercase", marginBottom:"12px" };
const TA = { width:"100%", background:"rgba(0,0,0,0.2)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"8px", color:"#e8e0d0", padding:"10px", fontSize:"14px", fontFamily:"inherit", resize:"none", outline:"none", lineHeight:"1.6", boxSizing:"border-box" };
