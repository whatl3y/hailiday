import type { ProjectPhase } from '../../state/projectStore';
import type { HeaderTone } from '../../ui/Layout';
import type { UploadSurface } from '../upload/UploadPanel';

export interface ProjectToneInput {
  phase: ProjectPhase;
  /** What the upload step shows: the holiday's photograph, or the chosen photo on its stage. */
  uploadSurface: UploadSurface;
  /** A look is on screen (result, or a render error that keeps the previous look). */
  hasVariant: boolean;
  /** The project's source has a picture to put on the stage. */
  hasSourcePicture: boolean;
  /** "Is this the right place?" has a Street View frame to show. */
  hasCandidate: boolean;
}

/**
 * The header's surface for a project screen: the ink band (`stage`) over every screen whose
 * picture sits on a stage directly under it, the transparent header (`photo`) over the holiday's
 * photograph, and paper everywhere else.
 */
export function projectTone({
  phase,
  uploadSurface,
  hasVariant,
  hasSourcePicture,
  hasCandidate,
}: ProjectToneInput): HeaderTone {
  switch (phase) {
    case 'upload':
    case 'nosv':
      return uploadSurface === 'photo' ? 'photo' : 'stage';
    case 'confirm':
      return hasCandidate ? 'stage' : 'paper';
    case 'starting':
    case 'waiting':
      return hasSourcePicture ? 'stage' : 'paper';
    case 'result':
    case 'render_error':
      return hasVariant || hasSourcePicture ? 'stage' : 'paper';
    default:
      return 'paper';
  }
}
