import { useId, useState } from 'react';
import { ROOM_TYPES, SCENE_TYPES, type RoomType, type SceneType } from '@holiday/core';
import { sceneTypeLabel, t } from '../../copy';

export interface SceneChoice {
  sceneType: SceneType;
  roomType: RoomType | null;
}

function roomLabel(roomType: RoomType): string {
  return sceneTypeLabel('interior', roomType);
}

/** "What's in this photo?": the four scene types, then the room type for `interior`. */
export function SceneChooser({
  value,
  required,
  onChoose,
}: {
  value: SceneChoice | null;
  required: boolean;
  onChoose: (choice: SceneChoice) => void;
}) {
  const headingId = useId();
  const roomHeadingId = useId();
  const [pendingInterior, setPendingInterior] = useState(value?.sceneType === 'interior');

  return (
    <div className={required ? 'scene-chooser scene-chooser--required' : 'scene-chooser'}>
      <p id={headingId} className="scene-chooser__heading">
        {t('scene.chooseHeading')}
      </p>
      <div className="holiday-inline" role="group" aria-labelledby={headingId}>
        {SCENE_TYPES.map((sceneType) => (
          <button
            key={sceneType}
            type="button"
            className="chip"
            aria-pressed={
              sceneType === 'interior'
                ? pendingInterior
                : value?.sceneType === sceneType && !pendingInterior
            }
            onClick={() => {
              if (sceneType === 'interior') {
                setPendingInterior(true);
                return;
              }
              setPendingInterior(false);
              onChoose({ sceneType, roomType: null });
            }}
          >
            {t(`scene.typeLabel.${sceneType}`)}
          </button>
        ))}
      </div>
      {pendingInterior ? (
        <>
          <p id={roomHeadingId} className="scene-chooser__heading">
            {t('scene.roomHeading')}
          </p>
          <div className="holiday-inline" role="group" aria-labelledby={roomHeadingId}>
            {ROOM_TYPES.map((roomType) => (
              <button
                key={roomType}
                type="button"
                className="chip"
                aria-pressed={value?.sceneType === 'interior' && value.roomType === roomType}
                onClick={() => onChoose({ sceneType: 'interior', roomType })}
              >
                <span className="cap-first">{roomLabel(roomType)}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
