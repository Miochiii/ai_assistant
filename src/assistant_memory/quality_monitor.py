"""Shadow-only scalar adaptation of the copied conditional CUSUM likelihood.

No memory-domain calibration exists yet; this emits diagnostics, never deletes data.
"""
import math

class MemoryQualityMonitor:
    def __init__(self, profile, baseline, threshold, allowance=.2):
        if not 0<baseline<1 or threshold<=0 or not 0<allowance<1: raise ValueError('invalid monitor')
        self.profile=profile; self.baseline=baseline; self.threshold=threshold; self.allowance=allowance
        self.value=0.; self.receipts={}; self.unknown=0
    def update(self, event_id, loss, profile):
        if profile!=self.profile: raise ValueError('new profile requires new epoch')
        if event_id in self.receipts:
            prior,result=self.receipts[event_id]
            if prior!=loss: raise ValueError('event conflict')
            return dict(result)
        if loss is None: self.unknown+=1
        else:
            if type(loss) not in (int,float) or loss not in (0,1): raise ValueError('binary known loss required')
            p0=self.baseline; p1=p0+self.allowance*(1-p0)
            self.value=max(0.,self.value+loss*math.log(p1/p0)+(1-loss)*math.log((1-p1)/(1-p0)))
        result={'statistic':self.value,'crossed':self.value>self.threshold,'unknown':self.unknown,
                'calibrated':False,'action':'diagnose_only','profile':self.profile}
        self.receipts[event_id]=(loss,result)
        return dict(result)
