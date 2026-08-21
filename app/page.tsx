import SearchForm from "@/components/search-form";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">MULTIMODAL ROUTE PLANNER · V0.3.5.2 GLOBAL BETA</p>
        <h1>Conduire juste assez.<br/>Prendre le bon train.</h1>
        <p className="hero-copy">Indique n’importe quelle ville ou adresse. L’app découvre les gares stratégiques, teste voiture + train et te dit où prendre le train — et à quelle heure partir.</p>
      </header>
      <SearchForm />
    </main>
  );
}
