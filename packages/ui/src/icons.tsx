import {
  Activity as ActivityData,
  Alert01Icon as AlertTriangleData,
  ArrowRight as ArrowRightData,
  ArrowUp01Icon as ArrowUpData,
  AudioLinesIcon as AudioLinesData,
  Bot as BotData,
  Bug as BugData,
  ChartNoAxesColumnIncreasingIcon as ChartNoAxesColumnIncreasingData,
  Check as CheckData,
  ChevronDown as ChevronDownData,
  ChevronLeft as ChevronLeftData,
  ChevronRight as ChevronRightData,
  ChevronUp as ChevronUpData,
  CircleAlert as CircleAlertData,
  Clapperboard as ClapperboardData,
  Clock03Icon as Clock3Data,
  Cpu as CpuData,
  Database as DatabaseData,
  FilePenLineIcon as FilePenLineData,
  FileSearch as FileSearchData,
  Film as FilmData,
  FolderOpen as FolderOpenData,
  FolderSearch as FolderSearchData,
  FolderX as FolderXData,
  GaugeIcon as GaugeData,
  Grid3X3Icon as Grid3X3Data,
  House as HouseData,
  Image as ImageData,
  Keyboard as KeyboardData,
  Layers as LayersData,
  Library as LibraryData,
  ListPlus as ListPlusData,
  ListTree as ListTreeData,
  ListVideo as ListVideoData,
  LoaderCircle as LoaderCircleData,
  Lock as LockData,
  LockOpen as LockOpenData,
  Magnet as MagnetData,
  Maximize2 as Maximize2Data,
  Menu as MenuData,
  Move as MoveData,
  MoveHorizontal as MoveHorizontalData,
  MousePointer2 as MousePointer2Data,
  Music2 as Music2Data,
  Pause as PauseData,
  Play as PlayData,
  Plus as PlusData,
  Redo2 as Redo2Data,
  RefreshCw as RefreshCwData,
  RotateCcw as RotateCcwData,
  Save as SaveData,
  Scissors as ScissorsData,
  Search as SearchData,
  Settings as SettingsData,
  SkipBack as SkipBackData,
  SlidersHorizontal as SlidersHorizontalData,
  Sparkles as SparklesData,
  Square as SquareData,
  StepBackIcon as StepBackData,
  StepForwardIcon as StepForwardData,
  StickyNote as StickyNoteData,
  Terminal as TerminalData,
  Trash2 as Trash2Data,
  Undo2 as Undo2Data,
  Video as VideoData,
  Volume2 as Volume2Data,
  VolumeX as VolumeXData,
  Wrench as WrenchData,
  X as XData,
  ZoomIn as ZoomInData,
  ZoomOut as ZoomOutData,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import { forwardRef } from "react";

type IconProps = Omit<HugeiconsIconProps, "icon">;

function createIcon(icon: IconSvgElement, displayName: string) {
  const Component = forwardRef<SVGSVGElement, IconProps>(function Icon(props, ref) {
    return <HugeiconsIcon ref={ref} icon={icon} {...props} />;
  });
  Component.displayName = displayName;
  return Component;
}

export const Activity = createIcon(ActivityData, "Activity");
export const AlertTriangle = createIcon(AlertTriangleData, "AlertTriangle");
export const ArrowRight = createIcon(ArrowRightData, "ArrowRight");
export const ArrowUp = createIcon(ArrowUpData, "ArrowUp");
export const AudioLines = createIcon(AudioLinesData, "AudioLines");
export const Bot = createIcon(BotData, "Bot");
export const Bug = createIcon(BugData, "Bug");
export const ChartNoAxesColumnIncreasing = createIcon(
  ChartNoAxesColumnIncreasingData,
  "ChartNoAxesColumnIncreasing",
);
export const Check = createIcon(CheckData, "Check");
export const ChevronDown = createIcon(ChevronDownData, "ChevronDown");
export const ChevronLeft = createIcon(ChevronLeftData, "ChevronLeft");
export const ChevronRight = createIcon(ChevronRightData, "ChevronRight");
export const ChevronUp = createIcon(ChevronUpData, "ChevronUp");
export const CircleAlert = createIcon(CircleAlertData, "CircleAlert");
export const Clapperboard = createIcon(ClapperboardData, "Clapperboard");
export const Clock3 = createIcon(Clock3Data, "Clock3");
export const Cpu = createIcon(CpuData, "Cpu");
export const Database = createIcon(DatabaseData, "Database");
export const FilePenLine = createIcon(FilePenLineData, "FilePenLine");
export const FileSearch = createIcon(FileSearchData, "FileSearch");
export const Film = createIcon(FilmData, "Film");
export const FolderOpen = createIcon(FolderOpenData, "FolderOpen");
export const FolderSearch = createIcon(FolderSearchData, "FolderSearch");
export const FolderX = createIcon(FolderXData, "FolderX");
export const Gauge = createIcon(GaugeData, "Gauge");
export const Grid3X3 = createIcon(Grid3X3Data, "Grid3X3");
export const House = createIcon(HouseData, "House");
export const Image = createIcon(ImageData, "Image");
export const Keyboard = createIcon(KeyboardData, "Keyboard");
export const Layers = createIcon(LayersData, "Layers");
export const Library = createIcon(LibraryData, "Library");
export const ListPlus = createIcon(ListPlusData, "ListPlus");
export const ListTree = createIcon(ListTreeData, "ListTree");
export const ListVideo = createIcon(ListVideoData, "ListVideo");
export const LoaderCircle = createIcon(LoaderCircleData, "LoaderCircle");
export const Lock = createIcon(LockData, "Lock");
export const LockOpen = createIcon(LockOpenData, "LockOpen");
export const Magnet = createIcon(MagnetData, "Magnet");
export const Maximize2 = createIcon(Maximize2Data, "Maximize2");
export const MenuIcon = createIcon(MenuData, "Menu");
export const Move = createIcon(MoveData, "Move");
export const MoveHorizontal = createIcon(MoveHorizontalData, "MoveHorizontal");
export const MousePointer2 = createIcon(MousePointer2Data, "MousePointer2");
export const Music2 = createIcon(Music2Data, "Music2");
export const Pause = createIcon(PauseData, "Pause");
export const Play = createIcon(PlayData, "Play");
export const Plus = createIcon(PlusData, "Plus");
export const Redo2 = createIcon(Redo2Data, "Redo2");
export const RefreshCw = createIcon(RefreshCwData, "RefreshCw");
export const RotateCcw = createIcon(RotateCcwData, "RotateCcw");
export const Save = createIcon(SaveData, "Save");
export const Scissors = createIcon(ScissorsData, "Scissors");
export const Search = createIcon(SearchData, "Search");
export const Settings = createIcon(SettingsData, "Settings");
export const SkipBack = createIcon(SkipBackData, "SkipBack");
export const SlidersHorizontal = createIcon(SlidersHorizontalData, "SlidersHorizontal");
export const Sparkles = createIcon(SparklesData, "Sparkles");
export const Square = createIcon(SquareData, "Square");
export const StepBack = createIcon(StepBackData, "StepBack");
export const StepForward = createIcon(StepForwardData, "StepForward");
export const StickyNote = createIcon(StickyNoteData, "StickyNote");
export const Terminal = createIcon(TerminalData, "Terminal");
export const Trash2 = createIcon(Trash2Data, "Trash2");
export const Undo2 = createIcon(Undo2Data, "Undo2");
export const Video = createIcon(VideoData, "Video");
export const Volume2 = createIcon(Volume2Data, "Volume2");
export const VolumeX = createIcon(VolumeXData, "VolumeX");
export const Wrench = createIcon(WrenchData, "Wrench");
export const X = createIcon(XData, "X");
export const ZoomIn = createIcon(ZoomInData, "ZoomIn");
export const ZoomOut = createIcon(ZoomOutData, "ZoomOut");
