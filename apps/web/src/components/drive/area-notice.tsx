import { FINISHING_KEY_CHANGE, type FamilyArea } from '@/components/drive/family-area';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/*
 * Why nothing can be added to a family folder right now, said plainly above
 * its list (plan section 5): its keys couldn't be checked on this device, the
 * server and the family's member list disagree about them, or a key change is
 * still walking the folder (decision D9: adding is refused until the walk
 * reaches it; nothing is queued, the person tries again). Nothing when the
 * folder can be written.
 */
export function AreaNotice({ area, waiting }: { area: FamilyArea; waiting: boolean }) {
    if (area.write === 'read-only')
        return (
            <div className="mx-5 mb-3 sm:mx-8" data-area-state="read-only">
                <Alert variant="warning">
                    <AlertTitle>You can open this folder but not add to it</AlertTitle>
                    <AlertDescription>
                        HushOS couldn’t check this folder’s keys on this device, so nothing is added
                        or changed here.
                    </AlertDescription>
                </Alert>
            </div>
        );
    if (area.write === 'keys-changed')
        return (
            <div className="mx-5 mb-3 sm:mx-8" data-area-state="keys-changed">
                <Alert variant="warning">
                    <AlertTitle>This folder’s keys changed</AlertTitle>
                    <AlertDescription>
                        HushOS checks {area.family} again before anything is added or changed here.
                        You can still open what’s in it.
                    </AlertDescription>
                    <AlertAction>
                        <Button size="sm" variant="outline" onClick={area.recheck}>
                            Check again
                        </Button>
                    </AlertAction>
                </Alert>
            </div>
        );
    if (waiting)
        return (
            <div className="mx-5 mb-3 sm:mx-8" data-area-state="key-change">
                <Alert variant="info">
                    <AlertTitle>{FINISHING_KEY_CHANGE}</AlertTitle>
                    <AlertDescription>
                        Nothing can be added to this folder until {area.family}’s new keys reach it;
                        try again then. You can still open what’s in it.
                    </AlertDescription>
                </Alert>
            </div>
        );
    return null;
}
