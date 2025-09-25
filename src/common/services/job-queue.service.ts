import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export interface JobProgress {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  message: string;
  result?: any;
  error?: string;
  userId?: string; // Add user ID to track job ownership
  cancelRequested?: boolean;
  cancelReason?: string;
}

@Injectable()
export class JobQueueService {
  private jobs = new Map<string, JobProgress>();

  createJob(userId?: string): string {
    const jobId = uuidv4();
    this.jobs.set(jobId, {
      status: 'pending',
      progress: 0,
      message: 'Job created, waiting to start',
      userId: userId,
    });
    return jobId;
  }

  getJobProgress(jobId: string): JobProgress | null {
    return this.jobs.get(jobId) || null;
  }

  updateJobProgress(jobId: string, update: Partial<JobProgress>): void {
    const currentJob = this.jobs.get(jobId);
    if (currentJob) {
      this.jobs.set(jobId, { ...currentJob, ...update });
    }
  }

  // Clean up completed jobs after some time
  startJobCleanup(jobId: string, timeoutMs: number = 3600000): void {
    setTimeout(() => {
      this.jobs.delete(jobId);
    }, timeoutMs);
  }

  requestCancel(jobId: string, reason?: string): boolean {
    const currentJob = this.jobs.get(jobId);
    if (!currentJob) {
      return false;
    }

    if (['completed', 'failed', 'cancelled'].includes(currentJob.status)) {
      return false;
    }

    const cancelReason = reason || currentJob.cancelReason || 'Cancellation requested by user';
    this.jobs.set(jobId, {
      ...currentJob,
      cancelRequested: true,
      cancelReason,
      message: cancelReason,
    });

    return true;
  }

  isCancelRequested(jobId: string): boolean {
    const currentJob = this.jobs.get(jobId);
    return !!currentJob?.cancelRequested;
  }

  markJobCancelled(jobId: string, update?: Partial<JobProgress>): void {
    const currentJob = this.jobs.get(jobId);
    if (!currentJob) {
      return;
    }

    const message = update?.message || currentJob.cancelReason || currentJob.message || 'Job cancelled';
    const progress = update?.progress ?? currentJob.progress ?? 0;

    this.jobs.set(jobId, {
      ...currentJob,
      ...update,
      status: 'cancelled',
      progress,
      message,
      cancelRequested: false,
      error: undefined,
    });
  }
} 