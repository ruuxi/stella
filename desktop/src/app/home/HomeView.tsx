import { HomeCanvas } from "./HomeCanvas"
import { MusicPlayer } from "./MusicPlayer"
import "./home-dashboard.css"

type HomeViewProps = {
  conversationId?: string
}

export function HomeView({ conversationId: _conversationId }: HomeViewProps) {
  return (
    <div className="home-root" data-stella-view="home" data-stella-label="Home Dashboard">
      <div className="home-dashboard home-dashboard--canvas-only">
        <div className="home-zone-canvas">
          <HomeCanvas />
        </div>
      </div>
      <div className="home-music-bar">
        <MusicPlayer />
      </div>
    </div>
  )
}
