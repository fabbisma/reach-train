import SearchForm from "@/components/search-form";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">MULTIMODAL ROUTE PLANNER · V0.1</p>
        <h1>Conduire juste assez.<br/>Prendre le bon train.</h1>
        <p className="hero-copy">Indique où tu vas et quand tu veux arriver. L'app teste les gares stratégiques et te dit où prendre le train — et à quelle heure quitter la maison.</p>
      </header>
      <SearchForm />
    </main>
  );
}
