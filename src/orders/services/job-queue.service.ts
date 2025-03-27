import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export interface JobProgress {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  message: string;
  result?: any;
  error?: string;
  userId?: string; // Add user ID to track job ownership
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
} 