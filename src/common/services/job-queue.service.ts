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

export type JobType = 'export-stamps' | 'process-excel';

@Injectable()
export class JobQueueService {
  private jobs = new Map<string, JobProgress>();
  private jobHandlers = new Map<JobType, Function>();

  constructor() {
    // Initialize with empty handlers
  }

  // Register a handler for a specific job type
  registerJobHandler(jobType: JobType, handler: Function): void {
    this.jobHandlers.set(jobType, handler);
  }

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

  // Add and start processing a job
  async addJob(jobType: JobType, data: any): Promise<string> {
    const jobId = this.createJob(data.userId);
    
    // Get the handler for this job type
    const handler = this.jobHandlers.get(jobType);
    if (!handler) {
      this.updateJobProgress(jobId, {
        status: 'failed', 
        error: `No handler registered for job type: ${jobType}`
      });
      return jobId;
    }
    
    // Start the job
    this.updateJobProgress(jobId, {
      status: 'processing',
      message: `处理中...`,
    });
    
    // Process the job asynchronously
    setTimeout(async () => {
      try {
        const result = await handler(jobId, data);
        this.updateJobProgress(jobId, {
          status: 'completed',
          progress: 100,
          message: '处理完成',
          result
        });
      } catch (error) {
        console.error(`Error processing ${jobType} job:`, error);
        this.updateJobProgress(jobId, {
          status: 'failed',
          message: '处理失败',
          error: error.message
        });
      }
      
      // Schedule cleanup after 24 hours
      this.startJobCleanup(jobId, 24 * 60 * 60 * 1000);
    }, 0);
    
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