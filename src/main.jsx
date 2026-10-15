import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }), ...options.headers }
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "No se pudo completar la solicitud.");
    error.code = data.code;
    throw error;
  }
  return data;
}

function ConsentLogin({ onLogin }) {
  const [username, setUsername] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [cookiesAccepted, setCookiesAccepted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, termsAccepted, cookiesAccepted })
      });
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate-page">
      <div className="gate-card">
        <Brand />
        <p className="eyebrow">UNA IA CON DEMASIADA CONFIANZA</p>
        <h1>Bienvenido a Filber.</h1>
        <p className="muted">Pregúntale lo que sea. Responde con información y un toque de troll, no con una tesis de 80 páginas.</p>
        <form onSubmit={submit} className="gate-form">
          <label className="consent-row">
            <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} />
            <span>Acepto los <a href="#terminos">términos y condiciones</a> y entiendo que mis preguntas y respuestas se guardan para prestar el servicio.</span>
          </label>
          <label className="consent-row">
            <input type="checkbox" checked={cookiesAccepted} onChange={(e) => setCookiesAccepted(e.target.checked)} />
            <span>Acepto la cookie necesaria para mantener mi sesión. Filber no usa cookies publicitarias.</span>
          </label>
          <label htmlFor="username">Tu nombre de usuario</label>
          <input id="username" autoComplete="nickname" maxLength="24" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Ej. FilberFan" required />
          <p className="fine-print">Sin contraseña: es un perfil anónimo en este navegador, no una identidad protegida. Verifica WhatsApp si quieres continuar tras tus 50 mensajes gratis.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary-button" disabled={busy || !termsAccepted || !cookiesAccepted}>{busy ? "Entrando…" : "Aceptar y entrar"}</button>
        </form>
        <div id="terminos" className="terms-copy">
          <strong>Términos en breve</strong>
          <p>Usa Filber de forma legal y respetuosa. Las respuestas pueden equivocarse: comprueba información importante con fuentes fiables. No envíes datos sensibles. El servicio puede limitar el uso. Puedes borrar tu perfil y sus conversaciones desde el menú.</p>
        </div>
      </div>
    </main>
  );
}

function Brand({ small = false }) {
  return <a className={`brand ${small ? "brand-small" : ""}`} href="/" aria-label="Filber inicio"><span className="brand-mark">f</span><span>filber</span></a>;
}

function Upgrade({ onClose, onVerified }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function sendCode(event) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("/api/otp/send", { method: "POST", body: JSON.stringify({ phone }) });
      setNotice(result.message); setSent(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function verify(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await api("/api/otp/verify", { method: "POST", body: JSON.stringify({ phone, code }) });
      onVerified(result.message);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop" role="presentation">
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
      <button className="icon-button modal-close" onClick={onClose} aria-label="Cerrar">×</button>
      <span className="modal-icon">✳</span>
      <h2 id="upgrade-title">Se acabaron los mensajes gratis.</h2>
      <p className="muted">Verifica tu número de WhatsApp para continuar. Después tendrás hasta 30 mensajes al día.</p>
      {!sent ? <form onSubmit={sendCode} className="stack-form">
        <label htmlFor="phone">Número en formato internacional</label>
        <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+51987654321" required />
        <button className="primary-button" disabled={busy}>{busy ? "Enviando…" : "Enviar código por WhatsApp"}</button>
      </form> : <form onSubmit={verify} className="stack-form">
        <label htmlFor="otp">Código de 6 dígitos</label>
        <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength="6" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
        <button className="primary-button" disabled={busy}>{busy ? "Verificando…" : "Verificar y continuar"}</button>
      </form>}
      {notice && <p className="success" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="fine-print">Se guarda el teléfono verificado para proteger el límite. No compartas el código con nadie.</p>
    </section>
  </div>;
}

function App() {
  const [user, setUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [contact, setContact] = useState("");
  const [recording, setRecording] = useState(false);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const listRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    Promise.all([
      api("/api/me").catch(() => null),
      api("/api/config").catch(() => ({ contactWhatsapp: "" }))
    ]).then(async ([session, config]) => {
      setContact(config.contactWhatsapp);
      if (session?.user) {
        setUser(session.user);
        try { setMessages((await api("/api/messages")).messages); }
        catch (err) { setError(err.message); }
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, loading]);

  async function sendMessage(event) {
    event?.preventDefault();
    const question = text.trim();
    if (!question || loading) return;
    setText(""); setError(""); setLoading(true);
    setMessages((old) => [...old, { id: `local-${Date.now()}`, role: "user", content: question }]);
    try {
      const result = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: question }) });
      setMessages((old) => [...old, result.assistantMessage]);
      if (result.freeMessages !== null) setUser((old) => ({ ...old, freeMessages: result.freeMessages }));
    } catch (err) {
      setError(err.message);
      if (err.code === "PHONE_VERIFICATION_REQUIRED") setShowUpgrade(true);
      setMessages((old) => old.filter((message) => !message.id.startsWith("local-")));
      setText(question);
    } finally { setLoading(false); }
  }

  async function startRecording() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("Tu navegador no permite grabar audio. Prueba con Chrome o escribe tu pregunta.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) return;
        const form = new FormData();
        form.append("audio", audio, "pregunta.webm");
        setLoading(true);
        try {
          const result = await api("/api/audio", { method: "POST", body: form });
          setMessages((old) => [...old, { id: `voice-${Date.now()}`, role: "user", content: result.userMessage }, result.assistantMessage]);
          if (result.freeMessages !== null) setUser((old) => ({ ...old, freeMessages: result.freeMessages }));
        } catch (err) {
          setError(err.message);
          if (err.code === "PHONE_VERIFICATION_REQUIRED") setShowUpgrade(true);
        } finally { setLoading(false); }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setUser(null); setMessages([]); setText("");
  }

  async function deleteAccount() {
    if (!window.confirm("¿Borrar este perfil y todas sus conversaciones? Esta acción no se puede deshacer.")) return;
    try {
      await api("/api/me", { method: "DELETE" });
      setUser(null); setMessages([]); setText("");
    } catch (err) { setError(err.message); }
  }

  if (!ready) return <div className="loading-screen"><Brand /><span className="loading-dot" /></div>;
  if (!user) return <ConsentLogin onLogin={(nextUser) => { setUser(nextUser); setMessages([]); }} />;

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand small />
      <button className="new-chat" onClick={() => { setMessages([]); setError(""); }}>＋ <span>Nuevo chat</span></button>
      <div className="sidebar-spacer" />
      <div className="sidebar-user">
        <div className="avatar">{user.username.charAt(0).toUpperCase()}</div>
        <div className="user-details"><strong>{user.username}</strong><span>{user.phoneVerified ? "WhatsApp verificado" : `${Math.max(0, user.freeMessageLimit - user.freeMessages)} mensajes gratis`}</span></div>
        <button className="icon-button" title="Borrar perfil y chats" onClick={deleteAccount}>⌫</button>
        <button className="icon-button" title="Salir" onClick={logout}>↗</button>
      </div>
    </aside>
    <main className="chat-main">
      <header className="topbar"><span className="model-label"><span className="status-dot" /> Filber <span className="model-muted">· IA con calle</span></span><span className="topbar-note">filber.tech</span></header>
      <section className={`conversation ${messages.length ? "has-messages" : ""}`} ref={listRef}>
        {messages.length === 0 && <div className="welcome">
          <div className="welcome-symbol">f</div>
          <p className="eyebrow">SIN RODEOS. BUENO, ALGUNOS.</p>
          <h1>¿Qué tienes en mente?</h1>
          <p className="muted">Pregunta algo. Buscaré en la web cuando haga falta y te responderé con datos, fuentes y una pizca de insolencia.</p>
          <div className="suggestions">
            {["¿Qué está pasando hoy en tecnología?", "Explícame la inflación como si tuviera sueño", "Dame una receta rica y barata"].map((suggestion) =>
              <button key={suggestion} onClick={() => setText(suggestion)}>{suggestion}<span>↗</span></button>)}
          </div>
        </div>}
        {messages.map((message) => <article className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`} key={message.id}>
          <div className="message-avatar">{message.role === "assistant" ? "f" : user.username.charAt(0).toUpperCase()}</div>
          <div className="message-body"><div className="message-name">{message.role === "assistant" ? "Filber" : user.username}</div><p>{message.content}</p>
            {message.sources?.length > 0 && <div className="sources"><span>Fuentes</span>{message.sources.map((source, index) =>
              <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">[{index + 1}] {source.title}</a>)}</div>}
          </div>
        </article>)}
        {loading && <div className="thinking"><span /><span /><span /> <small>Filber está pensando (sí, también le sorprende).</small></div>}
        {error && <div className="inline-error" role="alert">{error}{error.includes("WhatsApp") && <button onClick={() => setShowUpgrade(true)}>Verificar número</button>}</div>}
      </section>
      <div className="composer-wrap">
        {!user.phoneVerified && <div className="limit-note">{user.freeMessages} de {user.freeMessageLimit} mensajes gratis usados <button onClick={() => setShowUpgrade(true)}>Verificar WhatsApp</button></div>}
        <form className="composer" onSubmit={sendMessage}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} placeholder="Escribe tu pregunta a Filber…" rows="1" maxLength="5000" disabled={loading} />
          <div className="composer-actions">
            <button type="button" className={`audio-button ${recording ? "recording" : ""}`} onClick={recording ? stopRecording : startRecording} disabled={loading} title={recording ? "Detener y enviar audio" : "Grabar una pregunta de voz"}>{recording ? "■" : "♩"} <span>{recording ? "Detener" : "Audio"}</span></button>
            <span className="composer-hint">Enter para enviar · Shift+Enter nueva línea</span>
            <button type="submit" className="send-button" disabled={loading || !text.trim()} aria-label="Enviar pregunta">↑</button>
          </div>
        </form>
        <p className="disclaimer">Filber puede equivocarse. Revisa las fuentes antes de tomar decisiones importantes.</p>
      </div>
      <footer className="app-footer">
        {contact && <a href={`https://wa.me/${contact}?text=${encodeURIComponent("Hola Filber, quiero apoyar por Yape o enviar una sugerencia.")}`} target="_blank" rel="noreferrer">Apoyar por Yape / enviar sugerencias</a>}
        <span>Tu chat se guarda en la base de datos. <button onClick={deleteAccount}>Borrar mis datos</button></span>
      </footer>
    </main>
    {showUpgrade && <Upgrade onClose={() => setShowUpgrade(false)} onVerified={(message) => {
      setShowUpgrade(false); setUser((old) => ({ ...old, phoneVerified: true })); setToast(message); window.setTimeout(() => setToast(""), 4000);
    }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
