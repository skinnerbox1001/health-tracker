import { useState, useEffect, useRef } from "react";

const ENTRY_KEY = "health-tracker-entries";
const MED_KEY = "health-tracker-meds";

const moodLabels = ["","最悪","かなり辛い","辛い","しんどい","普通以下","まあまあ","普通","良い","かなり良い","最高"];
const moodColors = ["","#ef4444","#f97316","#fb923c","#fbbf24","#a3e635","#34d399","#22d3ee","#60a5fa","#818cf8","#c084fc"];

function getTodayKey() { return new Date().toISOString().split("T")[0]; }
function formatDate(d) {
  const dt = new Date(d);
  return `${dt.getMonth()+1}/${dt.getDate()}(${["日","月","火","水","木","金","土"][dt.getDay()]})`;
}
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("読み取り失敗"));
    r.readAsDataURL(file);
  });
}

export default function HealthTracker() {
  const [entries, setEntries]         = useState({});
  const [meds, setMeds]               = useState([]);
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
  const fileRef = useRef();

  useEffect(() => {
    try {
      const e = localStorage.getItem(ENTRY_KEY);
      if (e) {
        const p = JSON.parse(e); setEntries(p);
        const key = getTodayKey();
        if (p[key]) setToday(p[key]);
      }
    } catch {}
    try {
      const m = localStorage.getItem(MED_KEY);
      if (m) setMeds(JSON.parse(m));
    } catch {}
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
              { type: "text", text: `この処方箋から薬の情報を読み取り、必ずJSON配列のみを返してください（説明・マークダウン記号不要）。
形式: [{"name":"薬品名","dose":"用量","timing":"用法（朝食後など）","note":"備考"}]
薬が複数あれば全て含めてください。読み取れない場合は空配列[]を返してください。` }
            ]
          }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "[]";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setScannedMeds(parsed.map((m, i) => ({ ...m, id: `med_${Date.now()}_${i}` })));
    } catch {
      setScanError("読み取りに失敗しました。画像を確認して再度お試しください。");
    }
    setScanLoading(false); e.target.value = "";
  }

  function confirmScan() {
    if (!scannedMeds) return;
    saveMeds([...meds, ...scannedMeds]);
    setScannedMeds(null);
  }

  async function generateSummary() {
    setLoading(true); setAiSummary(""); setView("summary");
    const keys = Object.keys(entries).sort().slice(-14);
    if (keys.length === 0) {
      setAiSummary("記録がまだありません。まず数日間記録してから生成してください。");
      setLoading(false); return;
    }
    const medNames = meds.map(m => m.name).join("、") || "なし";
    const entryText = keys.map(k => {
      const e = entries[k];
      const takenList = meds.map(m => `${m.name}:${e.medsTaken?.[m.id] !== false ? "服薬" : "スキップ"}`).join(" ");
      return `【${formatDate(k)}】気分:${e.mood}/10 睡眠:${e.sleep}h 食事:${["ほぼ食べられなかった","少ししか","普通","よく食べた"][e.food??2]} 運動:${["なし","少し","しっかり"][e.exercise??0]}${e.exerciseNote?`(${e.exerciseNote})`:""} 服薬:[${takenList||"記録なし"}] 辛かった:${e.bad||"なし"} 良かった:${e.good||"なし"} メモ:${e.memo||"なし"}`;
    }).join("\n");

    const prompt = `患者の過去2週間の体調記録です。うつ病療養中。処方薬：${medNames}。
精神科・心療内科の診察（10〜15分）向けに整理してください。

【記録】
${entryText}

以下の形式で出力してください：

## 📊 2週間のまとめ
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
      });
      const data = await res.json();
      setAiSummary(data.content?.map(b => b.text||"").join("") || "生成に失敗しました");
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
        {[["log","今日"],["history","履歴"],["meds","お薬"],["summary","診察"]].map(([v,label]) => (
          <button key={v} onClick={() => setView(v)} style={{ flex:1, padding:"10px 4px", borderRadius:"10px", border:"none", background:view===v?"rgba(99,179,237,0.2)":"rgba(255,255,255,0.04)", color:view===v?"#63b3ed":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", borderBottom:view===v?"2px solid #63b3ed":"2px solid transparent", transition:"all 0.2s" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding:"8px 16px" }}>

        {/* 今日の記録 */}
        {view === "log" && (
          <div>
            <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"20px", textAlign:"center" }}>{formatDate(getTodayKey())} の記録</div>

            <div style={C}>
              <div style={L}>今日の気分</div>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"12px" }}>
                <div style={{ fontSize:"48px", fontWeight:"bold", color:moodColors[today.mood], lineHeight:1 }}>{today.mood}</div>
                <div><div style={{ fontSize:"16px", color:moodColors[today.mood] }}>{moodLabels[today.mood]}</div><div style={{ fontSize:"11px", color:"#7c8a9e" }}>10段階</div></div>
              </div>
              <input type="range" min="1" max="10" value={today.mood} onChange={e => setToday({...today,mood:+e.target.value})} style={{ width:"100%", accentColor:moodColors[today.mood] }} />
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:"10px", color:"#4a5568", marginTop:"4px" }}><span>最悪 1</span><span>10 最高</span></div>
            </div>

            <div style={C}>
              <div style={L}>睡眠時間</div>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"12px" }}>
                <div style={{ fontSize:"48px", fontWeight:"bold", color:"#63b3ed", lineHeight:1 }}>{today.sleep}</div>
                <div style={{ fontSize:"16px", color:"#63b3ed" }}>時間</div>
              </div>
              <input type="range" min="1" max="12" step="0.5" value={today.sleep} onChange={e => setToday({...today,sleep:+e.target.value})} style={{ width:"100%", accentColor:"#63b3ed" }} />
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
                      <button onClick={() => setToday(prev => ({ ...prev, medsTaken:{ ...prev.medsTaken, [m.id]:!taken } }))} style={{ padding:"8px 14px", borderRadius:"8px", border:`1px solid ${taken?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.1)"}`, background:taken?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.06)", color:taken?"#34d399":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.2s" }}>{taken?"✓ 服薬":"スキップ"}</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ ...C, border:"1px dashed rgba(255,255,255,0.1)", textAlign:"center", color:"#4a5568", fontSize:"13px", lineHeight:"1.8" }}>
                💊 「お薬」タブで処方箋を登録すると<br/>ここに服薬チェックが表示されます
              </div>
            )}

            <div style={C}>
              <div style={L}>🍚 今日の食事</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                {["ほぼ食べられなかった","少ししか食べられなかった","普通に食べた","よく食べた"].map((label,i) => (
                  <button key={i} onClick={() => setToday({...today,food:i})} style={{ padding:"12px 8px", borderRadius:"10px", border:`1px solid ${today.food===i?"rgba(251,191,36,0.4)":"rgba(255,255,255,0.07)"}`, background:today.food===i?"rgba(251,191,36,0.25)":"rgba(255,255,255,0.04)", color:today.food===i?"#fbbf24":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", lineHeight:"1.4", transition:"all 0.2s" }}>{label}</button>
                ))}
              </div>
            </div>

            <div style={C}>
              <div style={L}>🚶 今日の運動・外出</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"8px", marginBottom:"10px" }}>
                {["なし","少し動いた","しっかり動いた"].map((label,i) => (
                  <button key={i} onClick={() => setToday({...today,exercise:i})} style={{ padding:"12px 6px", borderRadius:"10px", border:`1px solid ${today.exercise===i?"rgba(52,211,153,0.4)":"rgba(255,255,255,0.07)"}`, background:today.exercise===i?"rgba(52,211,153,0.2)":"rgba(255,255,255,0.04)", color:today.exercise===i?"#34d399":"#7c8a9e", fontSize:"12px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.2s" }}>{label}</button>
                ))}
              </div>
              {today.exercise > 0 && <input type="text" value={today.exerciseNote||""} onChange={e => setToday({...today,exerciseNote:e.target.value})} placeholder="内容メモ（散歩20分など）" style={{...TA, padding:"8px 10px", fontSize:"13px"}} />}
            </div>

            <div style={C}><div style={L}>😔 辛かったこと・引き金になったこと</div><textarea value={today.bad} onChange={e => setToday({...today,bad:e.target.value})} placeholder="なければ空白でOK" style={TA} rows={3} /></div>
            <div style={C}><div style={L}>😊 良かったこと・ほっとしたこと</div><textarea value={today.good} onChange={e => setToday({...today,good:e.target.value})} placeholder="小さなことでもOK" style={TA} rows={3} /></div>
            <div style={C}><div style={L}>📝 その他メモ</div><textarea value={today.memo} onChange={e => setToday({...today,memo:e.target.value})} placeholder="特記事項など" style={TA} rows={2} /></div>

            <button onClick={saveEntry} style={{ width:"100%", padding:"16px", borderRadius:"12px", border:`1px solid ${saved?"rgba(52,211,153,0.4)":"rgba(99,179,237,0.3)"}`, background:saved?"rgba(52,211,153,0.3)":"rgba(99,179,237,0.25)", color:saved?"#34d399":"#63b3ed", fontSize:"16px", fontFamily:"inherit", cursor:"pointer", transition:"all 0.3s", fontWeight:"bold" }}>
              {saved ? "✓ 保存しました" : "今日の記録を保存"}
            </button>
          </div>
        )}

        {/* 履歴 */}
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

        {/* お薬管理 */}
        {view === "meds" && (
          <div>
            <div style={{ ...C, background:"rgba(99,179,237,0.06)", border:"1px solid rgba(99,179,237,0.2)", textAlign:"center" }}>
              <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"12px" }}>処方箋を撮影するとAIが薬の情報を自動読み取りします</div>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleScan} style={{ display:"none" }} />
              <button onClick={() => fileRef.current?.click()} disabled={scanLoading} style={{ width:"100%", padding:"14px", borderRadius:"10px", border:"1px solid rgba(99,179,237,0.4)", background:"rgba(99,179,237,0.15)", color:"#63b3ed", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold", opacity:scanLoading?0.6:1 }}>
                {scanLoading ? "📷 読み取り中..." : "📷 処方箋を撮影・読み込む"}
              </button>
              {scanError && <div style={{ marginTop:"10px", fontSize:"12px", color:"#f87171" }}>{scanError}</div>}
            </div>

            {scannedMeds && (
              <div style={{ ...C, border:"1px solid rgba(251,191,36,0.3)", background:"rgba(251,191,36,0.05)" }}>
                <div style={{ fontSize:"13px", color:"#fbbf24", marginBottom:"12px", fontWeight:"bold" }}>📋 読み取れた薬を確認してください</div>
                {scannedMeds.length === 0
                  ? <div style={{ fontSize:"13px", color:"#7c8a9e" }}>薬の情報を読み取れませんでした。画像を確認してください。</div>
                  : scannedMeds.map((m, i) => (
                    <div key={i} style={{ padding:"10px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize:"14px", color:"#e8e0d0", marginBottom:"2px" }}>{m.name}</div>
                      <div style={{ fontSize:"12px", color:"#7c8a9e" }}>{m.dose} ／ {m.timing}{m.note ? ` ／ ${m.note}` : ""}</div>
                    </div>
                  ))
                }
                <div style={{ display:"flex", gap:"10px", marginTop:"14px" }}>
                  {scannedMeds.length > 0 && <button onClick={confirmScan} style={{ flex:1, padding:"12px", borderRadius:"10px", border:"1px solid rgba(52,211,153,0.4)", background:"rgba(52,211,153,0.2)", color:"#34d399", fontSize:"14px", fontFamily:"inherit", cursor:"pointer", fontWeight:"bold" }}>✓ 登録する</button>}
                  <button onClick={() => setScannedMeds(null)} style={{ flex:1, padding:"12px", borderRadius:"10px", border:"1px solid rgba(255,255,255,0.1)", background:"rgba(255,255,255,0.05)", color:"#7c8a9e", fontSize:"14px", fontFamily:"inherit", cursor:"pointer" }}>キャンセル</button>
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
                    {m.note && <div style={{ fontSize:"11px", color:"#4a5568", marginTop:"2px" }}>{m.note}</div>}
                  </div>
                  <button onClick={() => saveMeds(meds.filter(x => x.id !== m.id))} style={{ padding:"6px 10px", borderRadius:"8px", border:"1px solid rgba(239,68,68,0.3)", background:"rgba(239,68,68,0.1)", color:"#f87171", fontSize:"12px", fontFamily:"inherit", cursor:"pointer" }}>削除</button>
                </div>
              ))
            }
          </div>
        )}

        {/* 診察サマリー */}
        {view === "summary" && (
          <div>
            <div style={{ ...C, background:"rgba(99,179,237,0.06)", border:"1px solid rgba(99,179,237,0.2)", marginBottom:"16px" }}>
              <div style={{ fontSize:"13px", color:"#7c8a9e", marginBottom:"8px" }}>直近14日間の記録をAIが分析して、診察に使えるサマリーを作ります</div>
              <div style={{ fontSize:"12px", color:"#4a5568" }}>記録: {Object.keys(entries).length}日分 ／ 処方薬: {meds.length}種</div>
            </div>
            <button onClick={generateSummary} disabled={loading} style={{ width:"100%", padding:"16px", borderRadius:"12px", border:"1px solid rgba(99,179,237,0.4)", background:"rgba(99,179,237,0.15)", color:"#63b3ed", fontSize:"15px", fontFamily:"inherit", cursor:loading?"not-allowed":"pointer", fontWeight:"bold", marginBottom:"20px", opacity:loading?0.6:1 }}>
              {loading ? "生成中..." : "📋 診察サマリーを生成"}
            </button>
            {loading && <div style={{ textAlign:"center", padding:"30px", color:"#7c8a9e" }}><div style={{ fontSize:"28px", marginBottom:"12px" }}>🤔</div><div style={{ fontSize:"14px" }}>記録を分析中...</div></div>}
            {aiSummary && !loading && <div style={{ ...C, whiteSpace:"pre-wrap", fontSize:"14px", lineHeight:"1.8", color:"#d4cfc8" }}>{aiSummary}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const C  = { background:"rgba(255,255,255,0.04)", borderRadius:"14px", padding:"16px", marginBottom:"12px", border:"1px solid rgba(255,255,255,0.07)" };
const L  = { fontSize:"12px", color:"#7c8a9e", letterSpacing:"1px", textTransform:"uppercase", marginBottom:"12px" };
const TA = { width:"100%", background:"rgba(0,0,0,0.2)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:"8px", color:"#e8e0d0", padding:"10px", fontSize:"14px", fontFamily:"inherit", resize:"none", outline:"none", lineHeight:"1.6", boxSizing:"border-box" };
