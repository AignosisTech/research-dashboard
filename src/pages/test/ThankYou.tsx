import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { ArrowRight } from 'lucide-react';

import { useTestStore } from '@/stores/testStore';

export const ThankYou = () => {
  const [timer, setTimer] = useState(5);
  const navigate = useNavigate();
  // A camp recording returns to its roster so the next child is one tap away.
  const campId = useTestStore(s => s.testData.camp_id);
  const destination = campId ? `/camps/${campId}` : '/dashboard';
  const destinationLabel = campId ? 'camp roster' : 'dashboard';

  useEffect(() => {
    if (timer === 0) {
      navigate(destination, { replace: true });
      return;
    }
    const interval = setInterval(() => {
      setTimer(prev => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [timer, navigate, destination]);

  return (
    <div className="dark flex min-h-screen flex-col items-center justify-center bg-background text-center">
      <div className="relative">
        <div className="absolute inset-0 rounded-lg bg-linear-to-r from-blue-500 to-primary opacity-60 blur-lg"></div>
        <h1 className="relative z-10 font-montserrat text-5xl font-semibold text-foreground">
          Aignosis
        </h1>
      </div>

      <div className="mt-2">
        <h2 className="font-manrope text-8xl font-bold text-foreground">Thank you</h2>
      </div>

      <div className="mt-6 max-w-2xl px-6 font-raleway text-foreground">
        <p className="text-center text-lg">
          Thank you for completing the assessment with Aignosis! Your responses bring us one step
          closer to understanding and supporting your child&apos;s unique needs.
          <br />
          <br />
        </p>
      </div>
      <div className="mt-6 flex flex-col items-center justify-center">
        <svg width="80" height="80" viewBox="0 0 80 80">
          <circle
            cx="40"
            cy="40"
            r="35"
            stroke="currentColor"
            strokeWidth="6"
            fill="none"
            opacity="0.2"
            className="text-primary"
          />
          <circle
            cx="40"
            cy="40"
            r="35"
            stroke="currentColor"
            strokeWidth="6"
            fill="none"
            strokeDasharray={2 * Math.PI * 35}
            strokeDashoffset={2 * Math.PI * 35 * (1 - timer / 5)}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
            className="text-primary"
          />
          <text
            x="40"
            y="50"
            textAnchor="middle"
            fontSize="1.5em"
            fill="currentColor"
            fontFamily="Manrope"
            className="fill-foreground"
          >
            {timer}
          </text>
        </svg>
        <span className="mt-2 flex items-center justify-center font-montserrat text-lg text-foreground">
          Redirecting to {destinationLabel} in 5 seconds
          <ArrowRight className="ml-1 h-4 w-4" />
        </span>
      </div>
    </div>
  );
};
