import {
  Banknote, Calendar, CalendarClock, Cat, Clock3, Coins, Compass, CupSoda,
  Flame, Footprints, Fuel, Grid2X2, Hash, House, KeyRound, MapPin,
  Milk, Mountain, Percent, ShoppingBag, Soup, Sun, Ticket, TrainFront,
  GalleryHorizontalEnd, type LucideIcon
} from "lucide-react";
import type { CellId } from "../../shared/domain";

const icons: Record<CellId, LucideIcon> = {
  discount: Percent,
  gasoline: Fuel,
  south: MapPin,
  "same-drink": Milk,
  ramen: Soup,
  "future-expiry": CalendarClock,
  locker: KeyRound,
  temperature: Sun,
  gamble: Ticket,
  "street-number": Hash,
  "bill-number": Banknote,
  "first-train": TrainFront,
  steps: Footprints,
  "old-expiry": Calendar,
  altitude: Mountain,
  "vending-price": CupSoda,
  "score-2048": Grid2X2,
  north: Compass,
  calorie: Flame,
  "real-estate": House,
  "vending-row": GalleryHorizontalEnd,
  convenience: ShoppingBag,
  cats: Cat,
  wait: Clock3,
  coin: Coins
};

export function TopicIcon({ cellId, size = 20 }: { cellId: CellId; size?: number }) {
  const Icon = icons[cellId];
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" />;
}
